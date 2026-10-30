// The release workflow rules (spec 0010): no npm credentials, check mode cannot publish, and the hold stops a publish. Each
// rule has a control that breaks it in a fixture, and each runs on the real files.
// Provenance: ported from tsukuri-labs/tsukuri spec 0009 (tools/quality/test/releaseWorkflow.test.ts, PR #29, merge
// commit d0c5a1de330200302edbad58784f351b09eeb4f8), from Effect's test API to Vitest. See PROVENANCE.md.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parse as parseYaml } from "yaml";

import {
  engineFindings,
  evaluateCondition,
  holdFindings,
  holdScript,
  modeFindings,
  stepScript,
  tokenFindings,
} from "../releaseWorkflow.ts";
import type { WorkflowFile } from "../releaseWorkflow.ts";
import {
  repoRoot,
  runBash,
  withScratch,
  writeFixture,
} from "./scriptHarness.ts";

const checkCondition =
  "inputs.mode == 'check' && github.ref == 'refs/heads/main'";

const publishCondition =
  "inputs.mode == 'publish' && github.ref == 'refs/heads/main'";

interface Changes {
  readonly beforeHold?: string;
  readonly checkRun?: string;
  readonly checkSteps?: string;
  readonly afterPublish?: string;
  readonly engines?: string;
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
  readonly workflowEnv?: string;
}

/** The step that removes `devEngines` in the fixture; a control replaces it (an empty string leaves it out). */
const enginesBlock = (changes: Changes): string =>
  changes.engines ??
  `      - name: npm may run here\n        run: jq 'del(.devEngines)' package.json > p && mv p package.json\n`;

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
        run: ${changes.checkRun ?? "npm publish ./dist --dry-run"}
${changes.checkSteps ?? ""}
  publish:
    if: ${changes.publishIf ?? publishCondition}
    runs-on: ubuntu-latest
    environment: npm-release
${changes.jobEnv ?? ""}${changes.jobExtra ?? ""}
    steps:
      - uses: actions/checkout@abc
${changes.beforeHold ?? ""}${holdBlock(changes)}${enginesBlock(changes)}      - name: Publish
${changes.publishExtra ?? ""}        run: ${changes.publishRun ?? "bunx changeset publish"}
${changes.afterPublish ?? ""}`,
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

describe("token-free workflows", () => {
  test("rejects token reads, npm auth configuration, and stored secret references", () => {
    expect(tokenFindings([release({})])).toStrictEqual([]);

    for (const text of [
      "secrets.NPM_TOKEN",
      'secrets["PUBLISH_KEY"]',
      "NODE_AUTH_TOKEN: value",
      "//registry.npmjs.org/:_authToken=anything",
      "NPM_CONFIG__AUTH: value",
      `npm_${"x".repeat(36)}`,
    ]) {
      expect(tokenFindings(fixture(text))).not.toStrictEqual([]);
    }
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

  test("a publish is not excused by a flag that turns the dry run off, or by a comment (controls)", () => {
    const reaches = mentions('with mode "check"');

    for (const checkRun of [
      'npm publish "$dist" --dry-run=false',
      'npm publish "$dist" --dry-run false',
      'npm publish "$dist" --dry-run --no-dry-run',
      'npm publish "$dist" --no-dry-run',
      'npm publish "$dist" # --dry-run',
      'echo "#"; npm publish "$dist" # --dry-run',
      "npm publish ./dist --dry-run=0",
    ]) {
      expect(reaches(modeFindings(release({ checkRun })))).toBe(true);
    }

    expect(
      modeFindings(
        release({ checkRun: 'npm publish "$dist" --dry-run # a dry run' })
      )
    ).toStrictEqual([]);
    expect(
      modeFindings(
        release({
          checkRun:
            "|\n          # npm publish ./dist\n          npm view x --dry-run",
        })
      )
    ).toStrictEqual([]);
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
  test("all workflows follow the token rule", () => {
    const workflows = readdirSync(path.join(repoRoot, ".github/workflows"))
      .filter((name) => /\.ya?ml$/u.test(name))
      .map((name) => ({
        name,
        text: readRepositoryFile(`.github/workflows/${name}`),
      }));

    expect(tokenFindings(workflows)).toStrictEqual([]);
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

    const workflow: unknown = parseYaml(text);
    expect(workflow).toMatchObject({
      jobs: {
        publish: {
          env: { NPM_CONFIG_PROVENANCE: "true" },
          environment: "npm-release",
          permissions: { "id-token": "write" },
        },
      },
    });
  });

  test("the secret declaration has no npm token", () => {
    expect(readRepositoryFile("secretspec.toml")).not.toContain("NPM_TOKEN");
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

describe("the devEngines removal", () => {
  test("holds for the shape in which a step removes devEngines before the publish", () => {
    expect(engineFindings(release({}))).toStrictEqual([]);
  });

  test("fails a publishing job without that step, with it after the publish, as an echo, or under an if (controls)", () => {
    const missing = mentions("removes devEngines");

    const removal =
      "jq 'del(.devEngines)' package.json > p && mv p package.json";

    expect(
      missing(
        engineFindings(
          release({
            afterPublish: `      - name: late\n        run: ${removal}\n`,
            engines: "",
          })
        )
      )
    ).toBe(true);
    expect(
      missing(
        engineFindings(
          release({
            engines: `      - name: talk\n        run: echo "del(.devEngines)"\n`,
          })
        )
      )
    ).toBe(true);
    expect(
      missing(
        engineFindings(
          release({
            engines: `      - name: maybe\n        if: false\n        run: ${removal}\n`,
          })
        )
      )
    ).toBe(true);

    expect(missing(engineFindings(release({ engines: "" })))).toBe(true);
    expect(
      missing(
        engineFindings(
          release({
            engines: "      - name: unrelated\n        run: echo hello\n",
          })
        )
      )
    ).toBe(true);
  });

  test("the real workflow removes devEngines before it publishes, and the check job (a dry run) needs no such step", () => {
    expect(
      engineFindings({
        name: "release.yml",
        text: readRepositoryFile(".github/workflows/release.yml"),
      })
    ).toStrictEqual([]);
  });
});

const published = (log: readonly string[]): readonly string[] =>
  log.filter((line) => line.startsWith("publish "));

describe("the publish step", () => {
  const releasePackages = ["core", "effect", "lint", "pg"];

  /** Runs the real `Publish` step in a scratch repository, with `devenv` and `npm` replaced by stubs that log. */
  const runPublish = (options: {
    readonly existing: readonly string[];
    readonly npmExit?: number;
    readonly pre?: string | undefined;
    readonly refuse?: string;
    readonly viewError?: string;
  }): {
    readonly exitCode: number;
    readonly log: readonly string[];
    readonly stdout: string;
  } =>
    withScratch((dir) => {
      const bin = path.join(dir, "bin");
      const log = path.join(dir, "npm.log");

      for (const name of releasePackages) {
        writeFixture(
          path.join(dir, "packages", name, "dist", "package.json"),
          `${JSON.stringify({ name: `@pg-txmode/${name}`, version: "0.1.0-alpha.1" })}\n`
        );
      }

      if (options.pre !== undefined) {
        writeFixture(path.join(dir, ".changeset", "pre.json"), options.pre);
      }

      writeFixture(
        path.join(bin, "devenv"),
        '#!/bin/sh\nshift 2\nexec "$@"\n',
        0o755
      );
      writeFixture(
        path.join(bin, "npm"),
        [
          "#!/bin/sh",
          'echo "$*" >> "$LOG"',
          'if [ "$1" = view ]; then',
          '  case " $EXISTING " in *" $2 "*) exit 0;; esac',
          '  if [ -n "$VIEW_ERROR" ]; then echo "$VIEW_ERROR" >&2; exit 1; fi',
          '  echo "npm error code E404" >&2',
          "  exit 1",
          "fi",
          'if [ -n "$REFUSE" ] && [ "$2" = "$REFUSE" ]; then echo "npm error code E403" >&2; exit 1; fi',
          'exit "${NPM_EXIT:-0}"',
          "",
        ].join("\n"),
        0o755
      );

      const script = stepScript(
        {
          name: "release.yml",
          text: readRepositoryFile(".github/workflows/release.yml"),
        },
        "publish",
        "Publish"
      );

      const result = runBash(
        ["-c", script ?? "exit 99"],
        {
          EXISTING: options.existing.join(" "),
          LOG: log,
          NPM_EXIT: String(options.npmExit ?? 0),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          REFUSE: options.refuse ?? "",
          VIEW_ERROR: options.viewError ?? "",
        },
        dir
      );

      return {
        ...result,
        log: existsSync(log)
          ? readFileSync(log, "utf-8")
              .split("\n")
              .filter((line) => line !== "")
          : [],
      };
    });

  const alpha = '{ "mode": "pre", "tag": "alpha" }';

  test("publishes each package the registry lacks to the tag of pre mode, core first", () => {
    const { exitCode, log } = runPublish({ existing: [], pre: alpha });

    expect(exitCode).toBe(0);
    expect(published(log)).toStrictEqual(
      releasePackages.map(
        (name) => `publish ./packages/${name}/dist --tag alpha --access public`
      )
    );
  });

  test("skips what the registry has, and publishes the rest (a re-run after a partial publish)", () => {
    const { exitCode, log, stdout } = runPublish({
      existing: [
        "@pg-txmode/core@0.1.0-alpha.1",
        "@pg-txmode/effect@0.1.0-alpha.1",
      ],
      pre: alpha,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "@pg-txmode/core@0.1.0-alpha.1 is on the registry: skipped"
    );
    expect(published(log)).toStrictEqual([
      "publish ./packages/lint/dist --tag alpha --access public",
      "publish ./packages/pg/dist --tag alpha --access public",
    ]);
    expect(
      published(
        runPublish({
          existing: releasePackages.map(
            (name) => `@pg-txmode/${name}@0.1.0-alpha.1`
          ),
          pre: alpha,
        }).log
      )
    ).toStrictEqual([]);
  });

  test("the tag is latest outside pre mode: no pre.json, or one that has left pre mode (controls)", () => {
    for (const pre of [undefined, '{ "mode": "exit", "tag": "alpha" }']) {
      expect(published(runPublish({ existing: [], pre }).log)[0]).toBe(
        "publish ./packages/core/dist --tag latest --access public"
      );
    }
  });

  test("stops at the first failed publish (control)", () => {
    const { exitCode, log } = runPublish({
      existing: [],
      npmExit: 1,
      pre: alpha,
    });

    expect(exitCode).not.toBe(0);
    expect(published(log)).toStrictEqual([
      "publish ./packages/core/dist --tag alpha --access public",
    ]);
  });

  test("a view error that is not E404 stops the step and is printed; nothing is published for it (control)", () => {
    const { exitCode, log, stdout } = runPublish({
      existing: [],
      pre: alpha,
      viewError: "npm error code ENOTFOUND registry unreachable",
    });

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not E404");
    expect(stdout).toContain("ENOTFOUND registry unreachable");
    expect(published(log)).toStrictEqual([]);
  });

  test("an error whose body mentions E404 outside npm's code line is not an E404 (control)", () => {
    const { exitCode, log, stdout } = runPublish({
      existing: [],
      pre: alpha,
      viewError:
        'npm error code E500\nnpm error 500 Internal Server Error - GET https://registry.npmjs.org/@pg-txmode%2fcore - upstream said "E404 Not Found"',
    });

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not E404");
    expect(published(log)).toStrictEqual([]);
  });

  test("a refused name (E403) stops the set, and a re-run skips what was published and publishes the rest", () => {
    const first = runPublish({
      existing: [],
      pre: alpha,
      refuse: "./packages/effect/dist",
    });

    expect(first.exitCode).not.toBe(0);
    expect(published(first.log)).toStrictEqual([
      "publish ./packages/core/dist --tag alpha --access public",
      "publish ./packages/effect/dist --tag alpha --access public",
    ]);

    const second = runPublish({
      existing: ["@pg-txmode/core@0.1.0-alpha.1"],
      pre: alpha,
    });

    expect(second.exitCode).toBe(0);
    expect(published(second.log)).toStrictEqual([
      "publish ./packages/effect/dist --tag alpha --access public",
      "publish ./packages/lint/dist --tag alpha --access public",
      "publish ./packages/pg/dist --tag alpha --access public",
    ]);
  });

  test("does not use changeset publish, which tags a second alpha latest (control)", () => {
    expect(
      stepScript(
        {
          name: "release.yml",
          text: readRepositoryFile(".github/workflows/release.yml"),
        },
        "publish",
        "Publish"
      )
    ).not.toMatch(/changeset\s+publish/u);
  });
});
