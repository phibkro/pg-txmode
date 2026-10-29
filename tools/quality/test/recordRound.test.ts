// Provenance: ported from reebeat/studio @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8 (tools/quality/test/recordRound.test.ts).
// Deviation: plain Vitest and node:child_process instead of Effect; the assertions are the same. See PROVENANCE.md.
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  repoRoot,
  runBash,
  withScratch,
  writeFixture,
} from "./scriptHarness.ts";

// The script is the contract: it runs with a stub `gh` first on PATH that records each call.
const stubGh = `#!/usr/bin/env bash
echo "$*" >>"$(dirname "$0")/gh-calls"
case "$1 $2" in
  "pr view") echo 0123456789abcdef0123456789abcdef01234567 ;;
  *) cat >/dev/null ;;
esac
`;

const run = (verdict: string, body: string) =>
  withScratch((dir) => {
    writeFixture(path.join(dir, "gh"), stubGh, 0o755);
    writeFixture(path.join(dir, "body.md"), body);

    const { exitCode } = runBash(
      [
        path.join(repoRoot, ".agents/skills/review-pr/record-round.sh"),
        "7",
        "1",
        verdict,
        path.join(dir, "body.md"),
      ],
      { PATH: `${dir}:${process.env.PATH ?? ""}` },
      repoRoot
    );

    return { called: existsSync(path.join(dir, "gh-calls")), exitCode };
  });

const body = (
  author: string,
  reviewers: string,
  checked = "plan, implementation, agreement"
) =>
  [
    `Author: ${author}`,
    `Reviewers: ${reviewers}`,
    ...(checked === "" ? [] : [`Checked: ${checked}`]),
    "",
    "No findings.",
  ].join("\n");

describe("record-round.sh", () => {
  test("records a pass whose reviewers are not the author", () => {
    expect(run("pass", body("Builder", "RevOne, RevTwo"))).toStrictEqual({
      called: true,
      exitCode: 0,
    });
  });

  test("refuses a pass that the author is among the reviewers of, before calling gh", () => {
    expect(run("pass", body("Builder", "RevOne,  builder "))).toStrictEqual({
      called: false,
      exitCode: 65,
    });
  });

  test("lets the author record a round that asks for changes", () => {
    expect(run("changes", body("Builder", "Builder"))).toStrictEqual({
      called: true,
      exitCode: 0,
    });
  });

  test("refuses a body without Author, Reviewers or Checked", () => {
    const refused = { called: false, exitCode: 65 };

    expect(run("pass", body("Builder", "RevOne", ""))).toStrictEqual(refused);
    expect(run("pass", "Reviewers: RevOne\nChecked: plan\n")).toStrictEqual(
      refused
    );
    expect(run("pass", "Author: A\nChecked: plan\n")).toStrictEqual(refused);
  });
});
