// Provenance: ported from reebeat/studio @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8 (tools/quality/test/effectExceptions.test.ts).
// Deviation: plain Vitest instead of Effect; the controls and expected findings are the same. See PROVENANCE.md.
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { checkExceptions } from "../exceptions.ts";
import type { ExceptionEntry } from "../exceptions.ts";
import { withScratch, writeFixture } from "./scriptHarness.ts";

interface Source {
  readonly path: string;
  readonly text: string;
}

const entry = (
  id: string,
  file: string,
  directive: string
): ExceptionEntry => ({
  id,
  nativeAlternativesExamined: ["fixture: no native alternative"],
  owner: "fixture",
  reason: "fixture",
  retirementTrigger: "fixture",
  scope: { directives: [directive], files: [file] },
  versions: {},
});

/** Writes the sources and the registry to a fresh temporary directory (removed afterwards) and checks them. */
const check = (
  sources: readonly Source[],
  exceptions: readonly ExceptionEntry[]
) =>
  withScratch((root) => {
    const registryPath = path.join(root, "exceptions.json");

    for (const source of sources) {
      writeFixture(path.join(root, source.path), source.text);
    }

    writeFixture(
      registryPath,
      JSON.stringify({ description: "fixture", exceptions })
    );

    return checkExceptions({
      paths: sources.map(({ path: file }) => file),
      registryPath,
      root,
    });
  });

const suppressed: Source = {
  path: "src/a.ts",
  text: "// oxlint-disable-next-line no-console\nconsole.log(1);\n",
};

describe("exception registry", () => {
  test("fails on a suppression without an entry and names file and line", () => {
    expect(check([suppressed], []).findings).toStrictEqual([
      "src/a.ts:1: unregistered oxlint-disable-next-line",
    ]);
  });

  test("passes when the suppression has an entry for its file and directive", () => {
    const { exceptionCount, findings } = check(
      [suppressed],
      [entry("EX-0001", "src/a.ts", "oxlint-disable-next-line")]
    );

    expect(findings).toStrictEqual([]);
    expect(exceptionCount).toBe(1);
  });

  test("fails on an entry whose suppression was removed", () => {
    expect(
      check(
        [{ path: "src/a.ts", text: "console.log(1);\n" }],
        [entry("EX-0001", "src/a.ts", "oxlint-disable-next-line")]
      ).findings
    ).toStrictEqual(["EX-0001 has no live suppression site"]);
  });

  test("fails on an entry for a file that does not exist", () => {
    expect(
      check(
        [{ path: "src/a.ts", text: "export const a = 1;\n" }],
        [entry("EX-0001", "src/gone.ts", "@ts-ignore")]
      ).findings
    ).toStrictEqual([
      "EX-0001 lists no existing source file",
      "EX-0001 has no live suppression site",
    ]);
  });

  test("does not accept an entry for another directive of the same file", () => {
    expect(
      check(
        [
          {
            path: "src/a.ts",
            text: "// @ts-ignore\nexport const a: number = '';\n",
          },
        ],
        [entry("EX-0001", "src/a.ts", "oxlint-disable-next-line")]
      ).findings
    ).toStrictEqual([
      "src/a.ts:1: unregistered @ts-ignore",
      "EX-0001 has no live suppression site",
    ]);
  });

  test("fails on a duplicate entry id", () => {
    expect(
      check(
        [suppressed],
        [
          entry("EX-0001", "src/a.ts", "oxlint-disable-next-line"),
          entry("EX-0001", "src/a.ts", "oxlint-disable-next-line"),
        ]
      ).findings
    ).toStrictEqual(["duplicate id EX-0001"]);
  });

  test("ignores directive text outside comments and files under node_modules", () => {
    expect(
      check(
        [
          {
            path: "src/a.ts",
            text: 'export const note = "oxlint-disable-next-line";\n',
          },
          { path: "node_modules/pkg/index.js", text: "// eslint-disable\n" },
        ],
        []
      ).findings
    ).toStrictEqual([]);
  });

  test("rejects a registry entry that lacks a required field", () => {
    expect(() =>
      withScratch((root) => {
        const registryPath = path.join(root, "exceptions.json");

        writeFixture(
          registryPath,
          JSON.stringify({
            description: "fixture",
            exceptions: [{ id: "EX-0001" }],
          })
        );

        return checkExceptions({ paths: [], registryPath, root });
      })
    ).toThrow(/nativeAlternativesExamined/u);
  });
});
