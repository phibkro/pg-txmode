// The release workflow rules (spec 0006): where the npm token comes from and goes, that `secretspec.toml` and the
// workflow name the same secret, that the `check` mode cannot publish, and that the release hold stops a publish. Each
// rule has a control that breaks it in a fixture, and each runs on the real files.
// Provenance: ported from tsukuri-labs/tsukuri spec 0009 (tools/quality/test/releaseWorkflow.test.ts, PR #29, merge
// commit d0c5a1de330200302edbad58784f351b09eeb4f8), from Effect's test API to Vitest. See PROVENANCE.md.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  declaredSecrets,
  evaluateCondition,
  holdFindings,
  holdScript,
  modeFindings,
  referencedSecrets,
  tokenFindings,
} from "../releaseWorkflow.ts";
import type { WorkflowFile } from "../releaseWorkflow.ts";
import {
  repoRoot,
  runBash,
  withScratch,
  writeFixture,
} from "./scriptHarness.ts";

/** A GitHub expression that reads the secret `name`. */
const expression = (name: string): string => `\${{ secrets.${name} }}`;

const secretspec = `[project]
name = "probe"
revision = "1.0"

[profiles.default]
NPM_TOKEN = { description = "token", required = true }

[profiles.default.defaults]
required = true
`;

const checkCondition =
  "inputs.mode == 'check' && github.ref == 'refs/heads/main'";

const publishCondition =
  "inputs.mode == 'publish' && github.ref == 'refs/heads/main'";

interface Changes {
  readonly beforeHold?: string;
  readonly checkRun?: string;
  readonly environment?: string;
  readonly holdExtra?: string;
  readonly jobEnv?: string;
  readonly jobExtra?: string;
  readonly mode?: string;
  readonly needs?: string;
  readonly noHold?: boolean;
  readonly publishExtra?: string;
  readonly publishIf?: string;
  readonly publishRun?: string;
  readonly secret?: string;
  readonly variable?: string;
  readonly workflowEnv?: string;
}

/** The hold step of the fixture: the real script's test, with a line a control may add to the step. */
const holdBlock = (changes: Changes): string =>
  changes.noHold === true
    ? ""
    : `      - name: Release hold\n        run: if [ -e .github/release-hold ]; then exit 1; fi\n${changes.holdExtra ?? ""}`;

/** A release workflow in the shape the real one has, with the lines a control changes made explicit. */
const release = (changes: Changes): WorkflowFile => ({
  name: "release.yml",
  text: `name: Release
on:
  workflow_dispatch:
    inputs:
      mode:
        type: choice
        options: [check, publish]
        default: ${changes.mode ?? "check"}
${changes.workflowEnv ?? ""}
jobs:
  check:
    if: ${checkCondition}
    runs-on: ubuntu-latest
    environment: ${changes.environment ?? "npm-release"}
${changes.needs ?? ""}
    steps:
      - name: Check
        env:
          ${changes.variable ?? "NODE_AUTH_TOKEN"}: ${expression(changes.secret ?? "NPM_TOKEN")}
        run: ${changes.checkRun ?? "npm whoami"}
  publish:
    if: ${changes.publishIf ?? publishCondition}
    runs-on: ubuntu-latest
    environment: npm-release
${changes.jobEnv ?? ""}${changes.jobExtra ?? ""}
    steps:
      - uses: actions/checkout@abc
${changes.beforeHold ?? ""}${holdBlock(changes)}      - name: Publish
${changes.publishExtra ?? ""}        env:
          NODE_AUTH_TOKEN: ${expression("NPM_TOKEN")}
        run: ${changes.publishRun ?? "bunx changeset publish"}
`,
});

/** A one-file workflow fixture. */
const fixture = (text: string): readonly WorkflowFile[] => [
  { name: "x.yml", text },
];

const mentions =
  (text: string) =>
  (lines: readonly string[]): boolean =>
    lines.some((line) => line.includes(text));

const readRepositoryFile = (name: string): string =>
  readFileSync(path.join(repoRoot, name), "utf-8");

describe("the npm token", () => {
  test("is declared once, read once, in the npm-release environment, as NODE_AUTH_TOKEN", () => {
    expect(tokenFindings([release({})], secretspec)).toStrictEqual([]);
    expect(
      referencedSecrets(
        `${expression("NPM_TOKEN")} ${expression("GITHUB_TOKEN")}`
      )
    ).toStrictEqual(["NPM_TOKEN"]);
    expect(declaredSecrets(secretspec)).toStrictEqual({
      ok: true,
      value: ["NPM_TOKEN"],
    });
  });

  test("fails when secretspec.toml and the workflow name different secrets (control)", () => {
    expect(
      tokenFindings([release({ secret: "NPM_PUBLISH_TOKEN" })], secretspec)
    ).toContain(
      "release.yml references secret NPM_PUBLISH_TOKEN, which secretspec.toml does not declare"
    );
    expect(
      tokenFindings(
        [release({})],
        secretspec.replace("NPM_TOKEN", "PUBLISH_TOKEN")
      )
    ).toContain(
      "no workflow reads PUBLISH_TOKEN, which secretspec.toml declares"
    );
  });

  test("fails a secretspec.toml that is not TOML or has no profile (controls)", () => {
    expect(
      mentions("not valid TOML")(tokenFindings([release({})], "NPM_TOKEN = ["))
    ).toBe(true);
    expect(
      mentions("no [profiles.*] table")(
        tokenFindings([release({})], '[project]\nname = "x"\n')
      )
    ).toBe(true);
  });

  test("fails a job that reads it outside the npm-release environment, so a repository secret could serve it (control)", () => {
    expect(
      mentions("outside the npm-release environment")(
        tokenFindings([release({ environment: "staging" })], secretspec)
      )
    ).toBe(true);
  });

  test("fails when it is read at workflow level or job level, not in one step (controls)", () => {
    expect(
      mentions("at workflow level")(
        tokenFindings(
          [
            release({
              workflowEnv: `env:\n  NODE_AUTH_TOKEN: ${expression("NPM_TOKEN")}`,
            }),
          ],
          secretspec
        )
      )
    ).toBe(true);
    expect(
      mentions("at job level")(
        tokenFindings(
          [
            release({
              jobEnv: `    env:\n      NODE_AUTH_TOKEN: ${expression("NPM_TOKEN")}\n`,
            }),
          ],
          secretspec
        )
      )
    ).toBe(true);
  });

  test("fails when it is echoed, traced or written to a file (controls)", () => {
    const printing = mentions("can print it");
    const literal = mentions("literal npm credential");

    expect(
      printing(
        tokenFindings(
          [release({ checkRun: "echo $NODE_AUTH_TOKEN" })],
          secretspec
        )
      )
    ).toBe(true);
    expect(
      printing(tokenFindings([release({ checkRun: "printenv" })], secretspec))
    ).toBe(true);
    expect(
      literal(
        tokenFindings(
          fixture(
            "run: echo '//registry.npmjs.org/:_authToken=abc123' > .npmrc"
          ),
          secretspec
        )
      )
    ).toBe(true);
    expect(
      literal(
        tokenFindings(fixture(`token: npm_${"x".repeat(36)}`), secretspec)
      )
    ).toBe(true);
    expect(
      literal(
        tokenFindings(
          fixture(
            `run: printf '%s' '//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}' > f`
          ),
          secretspec
        )
      )
    ).toBe(false);
  });

  test("fails a second secret declaration, and a variable other than NODE_AUTH_TOKEN (controls)", () => {
    expect(
      mentions("exactly one secret")(
        tokenFindings(
          [release({})],
          `${secretspec}\n[profiles.staging]\nOTHER = { description = "x" }\n`
        )
      )
    ).toBe(true);
    expect(
      mentions("only NODE_AUTH_TOKEN")(
        tokenFindings([release({ variable: "NPM_TOKEN" })], secretspec)
      )
    ).toBe(true);
  });
});

describe("the release mode", () => {
  const onMain = "refs/heads/main";

  test("reads the condition grammar of the workflow and refuses any other", () => {
    expect(
      evaluateCondition(publishCondition, { mode: "check", ref: onMain })
    ).toBe(false);
    expect(
      evaluateCondition(publishCondition, { mode: "publish", ref: onMain })
    ).toBe(true);
    expect(
      evaluateCondition(`\${{ ${publishCondition} }}`, {
        mode: "publish",
        ref: onMain,
      })
    ).toBe(true);
    expect(
      evaluateCondition("inputs.mode != 'check'", {
        mode: "check",
        ref: onMain,
      })
    ).toBeUndefined();
    expect(
      evaluateCondition("always()", { mode: "check", ref: onMain })
    ).toBeUndefined();
  });

  test("holds for the workflow in its intended shape: check never reaches the publish (baseline)", () => {
    expect(modeFindings(release({}))).toStrictEqual([]);
  });

  test("fails when the publish job has no mode condition, or one the gate cannot read (controls)", () => {
    expect(
      mentions('with mode "check"')(
        modeFindings(release({ publishIf: "github.ref == 'refs/heads/main'" }))
      )
    ).toBe(true);
    expect(
      mentions("cannot evaluate")(
        modeFindings(release({ publishIf: "inputs.mode != 'check'" }))
      )
    ).toBe(true);
    expect(
      mentions("refs/heads/feature")(
        modeFindings(release({ publishIf: "inputs.mode == 'publish'" }))
      )
    ).toBe(true);
  });

  test("fails when the check job holds a publish command, or needs the publisher (controls)", () => {
    expect(
      mentions('with mode "check"')(
        modeFindings(release({ checkRun: "npm publish ./dist" }))
      )
    ).toBe(true);
    expect(
      mentions("needs a job that publishes")(
        modeFindings(release({ needs: "    needs: publish" }))
      )
    ).toBe(true);
  });

  test("a dry run is not a publish, but a dry run cannot excuse a publish beside it (controls)", () => {
    expect(
      modeFindings(release({ checkRun: "npm publish ./dist --dry-run" }))
    ).toStrictEqual([]);
    expect(
      modeFindings(
        release({
          checkRun: "|\n          npm publish ./dist \\\n            --dry-run",
        })
      )
    ).toStrictEqual([]);
    expect(
      mentions('with mode "check"')(
        modeFindings(
          release({
            checkRun: "npm publish ./dist && npm publish ./other --dry-run",
          })
        )
      )
    ).toBe(true);
    expect(
      mentions('with mode "check"')(
        modeFindings(
          release({ checkRun: "npm publish ./dist ; echo --dry-run" })
        )
      )
    ).toBe(true);
  });

  test("fails when the default is not check, or no job publishes in publish mode (controls)", () => {
    expect(
      mentions("must default to check")(
        modeFindings(release({ mode: "publish" }))
      )
    ).toBe(true);
    expect(
      mentions("no job publishes")(
        modeFindings(release({ publishRun: "echo nothing" }))
      )
    ).toBe(true);
  });
});

describe("the real files", () => {
  test("secretspec.toml and the workflows follow the token rule", () => {
    const workflows: readonly WorkflowFile[] = [
      {
        name: "checks.yml",
        text: readRepositoryFile(".github/workflows/checks.yml"),
      },
      {
        name: "release.yml",
        text: readRepositoryFile(".github/workflows/release.yml"),
      },
    ];

    expect(
      tokenFindings(workflows, readRepositoryFile("secretspec.toml"))
    ).toStrictEqual([]);
  });

  test("the release workflow's check mode cannot reach a publish, for any mode or ref", () => {
    expect(
      modeFindings({
        name: "release.yml",
        text: readRepositoryFile(".github/workflows/release.yml"),
      })
    ).toStrictEqual([]);
  });

  test("the workflow keeps provenance: id-token write on the publisher and NPM_CONFIG_PROVENANCE", () => {
    const text = readRepositoryFile(".github/workflows/release.yml");

    expect(text).toContain("id-token: write");
    expect(text).toContain('NPM_CONFIG_PROVENANCE: "true"');
  });

  test("the check job dry-runs each package and holds no publish", () => {
    const text = readRepositoryFile(".github/workflows/release.yml");

    expect(text).toContain('npm publish "$dist" --dry-run');
  });
});

describe("the release hold", () => {
  const early = "      - name: Install\n        run: nix profile add x\n";

  test("holds for the shape in which the hold step follows the checkout", () => {
    expect(holdFindings(release({}))).toStrictEqual([]);
  });

  test("fails a publishing job without a hold step, or with a step before it (controls)", () => {
    expect(
      mentions("has no step that tests .github/release-hold")(
        holdFindings(release({ noHold: true }))
      )
    ).toBe(true);
    expect(
      mentions("before the release hold")(
        holdFindings(release({ beforeHold: early }))
      )
    ).toBe(true);
  });

  test("fails a hold that a failure does not stop: continue-on-error, or an if on a later step (controls)", () => {
    const bypass = mentions("hold");

    expect(
      bypass(
        holdFindings(
          release({ holdExtra: "        continue-on-error: true\n" })
        )
      )
    ).toBe(true);
    expect(
      bypass(
        holdFindings(release({ jobExtra: "\n    continue-on-error: true" }))
      )
    ).toBe(true);
    expect(
      mentions("has an if")(
        holdFindings(release({ publishExtra: "        if: always()\n" }))
      )
    ).toBe(true);
    expect(
      mentions("has an if")(
        holdFindings(
          release({ publishExtra: `        if: \${{ !cancelled() }}\n` })
        )
      )
    ).toBe(true);
  });

  test("the real hold step refuses where the file exists and passes where it does not, and the real job has one", () => {
    const workflow: WorkflowFile = {
      name: "release.yml",
      text: readRepositoryFile(".github/workflows/release.yml"),
    };

    const script = holdScript(workflow);

    expect(holdFindings(workflow)).toStrictEqual([]);
    expect(script).toBeDefined();

    withScratch((without) => {
      withScratch((withFile) => {
        writeFixture(
          path.join(withFile, ".github", "release-hold"),
          "on hold\n"
        );

        expect(runBash(["-c", script ?? "false"], {}, without).exitCode).toBe(
          0
        );
        expect(runBash(["-c", script ?? "false"], {}, withFile).exitCode).toBe(
          1
        );
      });
    });
  });
});
