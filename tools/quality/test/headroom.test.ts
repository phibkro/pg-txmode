// Provenance: ported from reebeat/studio @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8 (tools/quality/test/headroom.test.ts).
// Deviation: plain Vitest and node:child_process instead of Effect; the samples, controls and assertions are the same,
// and the script is pg-txmode's. See PROVENANCE.md.
//
// `headroom.sh` reads the kernel files from PROC_ROOT, so each gate has a control with an injected sample. A stub `sleep`
// first on PATH grows `pswpin` by STUB_SWAPIN_DELTA, which is the sample window.
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  repoRoot,
  runBash,
  withScratch,
  writeFixture,
} from "./scriptHarness.ts";

const stubSleep = `#!/usr/bin/env bash
current=$(awk '/^pswpin /{print $2}' "$PROC_ROOT/vmstat")
printf 'pswpin %d\\n' $((current + STUB_SWAPIN_DELTA)) >"$PROC_ROOT/vmstat"
`;

interface Sample {
  readonly memAvailMiB: number;
  // Pages swapped in during the 10 s sample window.
  readonly swapinPages: number;
  readonly psiFullAvg10: number;
  readonly psiFullAvg60: number;
  readonly load1: number;
  readonly nproc: number;
}

// 10 GiB of RAM, a 1 GiB expected demand: the memory gate needs MemAvailable of at least 3072 MiB.
const healthy: Sample = {
  load1: 2,
  memAvailMiB: 8192,
  nproc: 8,
  psiFullAvg10: 0.5,
  psiFullAvg60: 0.5,
  swapinPages: 100,
};

const memTotalMiB = 10_240;

// A file's replacement content, or null to leave the file out.
interface Overrides {
  readonly meminfo?: string | null;
  readonly vmstat?: string | null;
  readonly loadavg?: string | null;
  readonly memoryPressure?: string | null;
}

const gates = (stdout: string) => ({
  exitCode: Number(/exit=(?<code>\d+)/u.exec(stdout)?.groups?.code),
  short: stdout
    .split("\n")
    .flatMap(
      (line) => /^SHORT (?<gate>[^:]+):/u.exec(line)?.groups?.gate ?? []
    ),
});

const run = (sample: Sample, overrides: Overrides = {}) =>
  withScratch((dir) => {
    const proc = path.join(dir, "proc");

    writeFixture(path.join(dir, "bin", "sleep"), stubSleep, 0o755);

    // `undefined` keeps the healthy default, a string replaces the file, `null` leaves the file out.
    const write = (
      name: string,
      override: string | null | undefined,
      fallback: string
    ) => {
      if (override !== null) {
        writeFixture(path.join(proc, name), override ?? fallback);
      }
    };

    write(
      "meminfo",
      overrides.meminfo,
      `MemTotal: ${memTotalMiB * 1024} kB\nMemAvailable: ${sample.memAvailMiB * 1024} kB\n`
    );
    write("vmstat", overrides.vmstat, "pswpin 1000\n");
    write("loadavg", overrides.loadavg, `${sample.load1} 1.00 1.00 1/100 1\n`);
    write(
      "pressure/memory",
      overrides.memoryPressure,
      `some avg10=50.00 avg60=50.00 avg300=50.00 total=1\nfull avg10=${sample.psiFullAvg10} avg60=${sample.psiFullAvg60} avg300=0.00 total=1\n`
    );

    const script = path.join(
      repoRoot,
      ".agents/skills/verify-pg-txmode/scripts/headroom.sh"
    );

    const { stdout } = runBash(
      ["-c", '"$0"; echo "exit=$?"', script],
      {
        DEMAND_DISK_MIB: "1",
        DEMAND_MEM_MIB: "1024",
        HEADROOM_NPROC: String(sample.nproc),
        PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`,
        PROC_ROOT: proc,
        SAMPLE_SECONDS: "10",
        STUB_SWAPIN_DELTA: String(sample.swapinPages),
        VERIFY_EVIDENCE_ROOT: path.join(dir, "evidence"),
      },
      repoRoot
    );

    return gates(stdout);
  });

const passes = { exitCode: 0, short: [] };

describe("headroom.sh gates (injected /proc samples)", () => {
  test("passes a healthy machine", () => {
    expect(run(healthy)).toStrictEqual(passes);
  });

  test("memory: MemAvailable after the demand under 20% of RAM is short; exactly 20% passes", () => {
    expect(run({ ...healthy, memAvailMiB: 3071 })).toStrictEqual({
      exitCode: 1,
      short: ["memory"],
    });
    expect(run({ ...healthy, memAvailMiB: 3072 })).toStrictEqual(passes);
  });

  test("swap-in: 1000 pages per second or more is short, just under passes", () => {
    expect(run({ ...healthy, swapinPages: 10_000 })).toStrictEqual({
      exitCode: 1,
      short: ["swap-in"],
    });
    expect(run({ ...healthy, swapinPages: 9990 })).toStrictEqual(passes);
  });

  test("memory PSI: full avg60 of 10% or more is short; avg10 and `some` are not gated", () => {
    expect(run({ ...healthy, psiFullAvg60: 10 })).toStrictEqual({
      exitCode: 1,
      short: ["memory PSI"],
    });
    expect(
      run({ ...healthy, psiFullAvg10: 80, psiFullAvg60: 9.99 })
    ).toStrictEqual(passes);
  });

  test("load: a 1-minute load average at the number of threads or more is short", () => {
    expect(run({ ...healthy, load1: 8 })).toStrictEqual({
      exitCode: 1,
      short: ["load"],
    });
    expect(run({ ...healthy, load1: 7.99 })).toStrictEqual(passes);
  });

  test("reports every gate that is short, not only the first", () => {
    expect(run({ ...healthy, load1: 9, psiFullAvg60: 30 })).toStrictEqual({
      exitCode: 1,
      short: ["memory PSI", "load"],
    });
  });

  // A gate whose sample cannot be read is short: the file is missing, empty, or not a number.
  test("unreadable samples: a missing, empty or non-numeric file makes that gate short, one control per gate", () => {
    const cases: readonly (readonly [string, Overrides])[] = [
      ["memory", { meminfo: null }],
      ["memory", { meminfo: "MemTotal: lots kB\nMemAvailable: 1 kB\n" }],
      ["swap-in", { vmstat: null }],
      ["swap-in", { vmstat: "pswpin many\n" }],
      ["memory PSI", { memoryPressure: null }],
      ["memory PSI", { memoryPressure: "" }],
      ["memory PSI", { memoryPressure: "full avg10=x avg60=n/a\n" }],
      ["load", { loadavg: null }],
      ["load", { loadavg: "\n" }],
      ["load", { loadavg: "unknown 1 1\n" }],
    ];

    for (const [gate, overrides] of cases) {
      expect(run(healthy, overrides)).toStrictEqual({
        exitCode: 1,
        short: [gate],
      });
    }
  });
});
