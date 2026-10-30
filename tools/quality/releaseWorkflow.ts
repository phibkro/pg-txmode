// The release workflow rules of spec 0006: where the npm token may come from and go, that the `check` mode cannot
// publish, and that the release hold stops the publish. Pure functions over file text, so tests run them on fixtures
// (with a control for each way of leaking, drifting or reaching the publish) and on the real files. Plain TypeScript
// (no Effect), like the rest of tools/.
// Provenance: ported from tsukuri-labs/tsukuri (the reebeat repository, Apache-2.0) spec 0009, PR #29, merge commit
// d0c5a1de330200302edbad58784f351b09eeb4f8 (tools/quality/releaseWorkflow.ts). Deviations: plain TypeScript with zod,
// `yaml` and `smol-toml` instead of Effect Schema and its TOML codec; a publish command with `--dry-run` is not a
// publish (the `check` job dry-runs each package). See PROVENANCE.md.
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** The one environment whose secret may carry the token. */
const releaseEnvironment = "npm-release";

/** The one step variable npm reads the token from (`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`). */
const tokenVariable = "NODE_AUTH_TOKEN";

/** A workflow file: its name under `.github/workflows` and its text. */
export interface WorkflowFile {
  readonly name: string;
  readonly text: string;
}

/** Either a value or the sentence that says why there is none. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

const secretReference = /\bsecrets\.(?<name>[A-Za-z_][A-Za-z0-9_]*)/gu;

/** `secrets.GITHUB_TOKEN` is GitHub's own per-run token, not a stored credential. */
const builtIn = "GITHUB_TOKEN";

/** The names of the secrets a text references (`secrets.NAME`), once each, without GitHub's own token. */
export const referencedSecrets = (text: string): readonly string[] => [
  ...new Set(
    [...text.matchAll(secretReference)].flatMap(({ groups }) =>
      groups?.name === undefined || groups.name === builtIn ? [] : [groups.name]
    )
  ),
];

const SecretspecSchema = z.object({
  profiles: z.record(z.string(), z.record(z.string(), z.looseObject({}))),
});

/** The names of the secrets `secretspec.toml` declares, in every profile (`defaults` holds settings, not a secret). */
export const declaredSecrets = (toml: string): Outcome<readonly string[]> => {
  try {
    const decoded = SecretspecSchema.safeParse(parseToml(toml));

    return decoded.success
      ? {
          ok: true,
          value: [
            ...new Set(
              Object.values(decoded.data.profiles).flatMap((profile) =>
                Object.keys(profile).filter((name) => name !== "defaults")
              )
            ),
          ],
        }
      : { ok: false, problem: "secretspec.toml has no [profiles.*] table" };
  } catch (error) {
    return {
      ok: false,
      problem: `secretspec.toml is not valid TOML: ${error instanceof Error ? error.message : "unreadable"}`,
    };
  }
};

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const Values = z.record(z.string(), scalar);

const StepSchema = z.object({
  "continue-on-error": scalar.optional(),
  env: Values.optional(),
  if: scalar.optional(),
  name: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  with: Values.optional(),
});

const EnvironmentSchema = z.union([
  z.string(),
  z.object({ name: z.string() }).transform(({ name }) => name),
]);

const JobSchema = z.object({
  "continue-on-error": scalar.optional(),
  env: Values.optional(),
  environment: EnvironmentSchema.optional(),
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  steps: z.array(StepSchema).optional(),
});

const WorkflowSchema = z.object({
  env: Values.optional(),
  jobs: z.record(z.string(), JobSchema),
});

type Step = z.infer<typeof StepSchema>;

type Job = z.infer<typeof JobSchema>;

type Parsed = z.infer<typeof WorkflowSchema>;

const parseWorkflow = (file: WorkflowFile): Outcome<Parsed> => {
  try {
    const decoded = WorkflowSchema.safeParse(parseYaml(file.text));

    return decoded.success
      ? { ok: true, value: decoded.data }
      : { ok: false, problem: `${file.name} is not a workflow` };
  } catch {
    return { ok: false, problem: `${file.name} is not valid YAML` };
  }
};

const mentions = (
  values: Readonly<Record<string, string | number | boolean>> | undefined
): boolean =>
  Object.values(values ?? {}).some(
    (value) => referencedSecrets(String(value)).length > 0
  );

/** `${{ secrets.NPM_TOKEN }}` and nothing else: the one value the token variable may have. */
const tokenExpression = (name: string): string => `\${{ secrets.${name} }}`;

/** A literal credential: an npm token (`npm_` and 20 or more characters) or an `_authToken` that is not the variable. */
const literalToken =
  /\bnpm_[A-Za-z0-9]{20,}|_authToken\s*=\s*(?!\$\{NODE_AUTH_TOKEN\})\S/u;

/**
 * What a step that holds the token must not run: a command that prints the environment or traces it. A deny-list of the
 * usual printers (the name, `printenv`, bare `env`, `export`, `declare`/`typeset`, a bare `set`, `compgen -e`, the
 * process environment, `set -x`); it is a guard against a slip, not a proof that nothing can print the token.
 */
const exposing = new RegExp(
  [
    "NODE_AUTH_TOKEN",
    String.raw`\bprintenv\b`,
    String.raw`\bset\s+-\w*x`,
    String.raw`(?:^|\n|;|&&|\|)\s*env\s*(?:\||;|\n|$)`,
    String.raw`(?:^|\n|;|&&|\|)\s*export\s*(?:-\w+\s*)*(?:\||;|\n|$)`,
    String.raw`\b(?:declare|typeset)\s+-\w*[xp]`,
    String.raw`(?:^|\n|;|&&|\|)\s*set\s*(?:\||;|\n|$)`,
    String.raw`\bcompgen\s+-\w*e`,
    String.raw`/proc/[^\s]*environ`,
    String.raw`\bprocess\.env\b`,
  ].join("|"),
  "u"
);

const stepLabel = (step: Step): string => step.name ?? "(unnamed)";

const stepFindings = (
  where: string,
  step: Step,
  secret: string
): readonly string[] => {
  const label = `${where} step ${stepLabel(step)}`;
  const findings: string[] = [];

  if (
    mentions(step.with) ||
    (step.run !== undefined && referencedSecrets(step.run).length > 0)
  ) {
    findings.push(
      `${label} puts a secret in run or with, where it can be echoed`
    );
  }

  if (!mentions(step.env)) {
    return findings;
  }

  for (const [variable, value] of Object.entries(step.env ?? {})) {
    const text = String(value);

    if (
      referencedSecrets(text).length > 0 &&
      (variable !== tokenVariable || text !== tokenExpression(secret))
    ) {
      findings.push(
        `${label} sets ${variable} to ${text}; only ${tokenVariable}: ${tokenExpression(secret)} is allowed`
      );
    }
  }

  if (step.run !== undefined && exposing.test(step.run)) {
    findings.push(
      `${label} holds the token and runs something that can print it`
    );
  }

  return findings;
};

const jobFindings = (
  file: WorkflowFile,
  secret: string,
  [jobName, job]: readonly [string, Job]
): readonly string[] => {
  const steps = job.steps ?? [];
  const where = `${file.name} job ${jobName}`;
  const findings: string[] = [];

  if (mentions(job.env)) {
    findings.push(
      `${where} reads a secret at job level, not in the one step that runs npm`
    );
  }

  const tokenSteps = steps.filter((step) => mentions(step.env));

  if (tokenSteps.length > 0 && job.environment !== releaseEnvironment) {
    findings.push(
      `${where} reads the token outside the ${releaseEnvironment} environment, so a repository secret would serve it`
    );
  }

  if (tokenSteps.length > 1) {
    findings.push(
      `${where} reads the token in ${tokenSteps.length} steps; it may be read in one`
    );
  }

  return [
    ...findings,
    ...steps.flatMap((step) => stepFindings(where, step, secret)),
  ];
};

const workflowFindings = (
  file: WorkflowFile,
  secret: string
): readonly string[] => {
  const references = referencedSecrets(file.text);

  const literal = literalToken.test(file.text)
    ? [
        `${file.name} holds a literal npm credential or an _authToken that is not \${${tokenVariable}}`,
      ]
    : [];

  if (references.length === 0) {
    return literal;
  }

  const parsed = parseWorkflow(file);

  if (!parsed.ok) {
    return [...literal, parsed.problem];
  }

  return [
    ...literal,
    ...references
      .filter((name) => name !== secret)
      .map(
        (name) =>
          `${file.name} references secret ${name}, which secretspec.toml does not declare`
      ),
    ...(mentions(parsed.value.env)
      ? [`${file.name} reads a secret at workflow level`]
      : []),
    ...Object.entries(parsed.value.jobs).flatMap((job) =>
      jobFindings(file, secret, job)
    ),
  ];
};

/**
 * Sentences about how the workflows and `secretspec.toml` break the token rule. Empty when: `secretspec.toml` declares
 * exactly one secret; the workflows read exactly that secret (and GitHub's own token); a job reads it only in the
 * `npm-release` environment, in a step's `env` as `NODE_AUTH_TOKEN: ${{ secrets.<name> }}`, and that step prints
 * nothing of it; and no file holds a literal token. A repository secret of the same name cannot be seen from these
 * files: the job's `environment` is what makes the environment secret win, and `gh secret list` shows the rest.
 */
export const tokenFindings = (
  workflows: readonly WorkflowFile[],
  secretspec: string
): readonly string[] => {
  const declared = declaredSecrets(secretspec);

  if (!declared.ok) {
    return [declared.problem];
  }

  const [secret, ...others] = declared.value;

  if (secret === undefined || others.length > 0) {
    return [
      `secretspec.toml must declare exactly one secret, found: ${declared.value.length > 0 ? declared.value.join(", ") : "none"}`,
    ];
  }

  const referenced = workflows.flatMap(({ text }) => referencedSecrets(text));

  return [
    ...(referenced.includes(secret)
      ? []
      : [`no workflow reads ${secret}, which secretspec.toml declares`]),
    ...workflows.flatMap((file) => workflowFindings(file, secret)),
  ];
};

/** The contexts a job condition may test: the dispatch input and the ref. */
export interface RunContext {
  readonly mode: string;
  readonly ref: string;
}

const term =
  /^(?<context>inputs\.mode|github\.ref)\s*==\s*'(?<literal>[^']*)'$/u;

/**
 * Evaluates the one condition grammar the release workflow may use: `<context> == '<literal>'` terms joined by `&&`
 * (the contexts `inputs.mode` and `github.ref`), optionally inside `${{ }}`. Anything else is not evaluated
 * (`undefined`): the gate fails closed on a condition it cannot read.
 */
export const evaluateCondition = (
  condition: string,
  run: RunContext
): boolean | undefined => {
  const terms = condition
    .trim()
    .replaceAll(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .split("&&")
    .map((text) => term.exec(text.trim())?.groups);

  const matched = terms.flatMap((groups) =>
    groups === undefined ? [] : [groups]
  );

  return matched.length === terms.length
    ? matched.every((groups) =>
        groups.context === "inputs.mode"
          ? groups.literal === run.mode
          : groups.literal === run.ref
      )
    : undefined;
};

const publishCommand =
  /\bchangeset\s+publish\b|\bnpm\s+(?:stage\s+)?publish\b|\bbun\s+publish\b|\bpnpm\s+publish\b|\byarn\s+npm\s+publish\b/u;

/**
 * The script without shell comments. A `#` outside quotes, at the start of a line or after whitespace, starts a comment
 * that runs to the end of the line (a `#` inside quotes is text, and stays). Quote state carries across lines. Without
 * this a trailing `# --dry-run` would excuse a publish.
 */
const withoutComments = (script: string): string => {
  let quote: string | undefined;
  let comment = false;
  let previous = "\n";
  let out = "";

  for (const char of script) {
    if (comment) {
      if (char === "\n") {
        comment = false;
        out += char;
      }
    } else if (quote === undefined && char === "#" && /\s/u.test(previous)) {
      comment = true;
    } else {
      if (char === quote) {
        quote = undefined;
      } else if (quote === undefined && (char === "'" || char === '"')) {
        quote = char;
      }

      out += char;
    }

    previous = char;
  }

  return out;
};

/**
 * The simple commands of a script: comments are dropped, backslash continuations are joined (a flag on the next line
 * belongs to its command), then each line is split at `;`, `&&`, `||` and `|`, so a `--dry-run` in one command cannot
 * excuse a publish in another.
 */
const commands = (script: string): readonly string[] =>
  withoutComments(script)
    .replaceAll(/\\\r?\n\s*/gu, " ")
    .split(/\r?\n/u)
    .flatMap((line) => line.split(/&&|\|\||;|\|/u));

/** A bare `--dry-run`: not `--dry-run=false`, `--dry-run false`, `--no-dry-run`, and not one a later flag undoes. */
const dryRun = (command: string): boolean =>
  /(?:^|\s)--dry-run(?=\s|$)/u.test(command) &&
  !/--dry-run=|--no-dry-run|--dry-run\s+(?:false|0|no)\b/u.test(command);

/** True when a script runs a publish command that is not a dry run (`--dry-run` publishes nothing). */
const publishes = (script: string | undefined): boolean =>
  commands(script ?? "").some(
    (command) => publishCommand.test(command) && !dryRun(command)
  );

const DispatchSchema = z.object({
  on: z.object({
    workflow_dispatch: z.object({
      inputs: z.object({
        mode: z.object({
          default: z.string(),
          options: z.array(z.string()),
          type: z.string(),
        }),
      }),
    }),
  }),
});

type ModeInput = z.infer<
  typeof DispatchSchema
>["on"]["workflow_dispatch"]["inputs"]["mode"];

const parseDispatch = (file: WorkflowFile): Outcome<ModeInput> => {
  try {
    const decoded = DispatchSchema.safeParse(parseYaml(file.text));

    return decoded.success
      ? { ok: true, value: decoded.data.on.workflow_dispatch.inputs.mode }
      : {
          ok: false,
          problem: `${file.name} has no workflow_dispatch input mode`,
        };
  } catch {
    return { ok: false, problem: `${file.name} is not valid YAML` };
  }
};

const modes: readonly string[] = ["check", "publish"];

/** `main`, the one ref a release runs from. */
const releaseRef = "refs/heads/main";

/** The jobs of `workflow` that run for a dispatch with this mode and ref, or the jobs whose condition cannot be read. */
const jobsRunning = (
  workflow: Parsed,
  run: RunContext
): Outcome<readonly string[]> => {
  const decided = Object.entries(workflow.jobs).map(([name, job]) => ({
    name,
    runs: job.if === undefined ? true : evaluateCondition(job.if, run),
  }));

  const undecided = decided.filter(({ runs }) => runs === undefined);

  return undecided.length > 0
    ? {
        ok: false,
        problem: `${undecided.map(({ name }) => name).join(", ")} has a condition the gate cannot evaluate`,
      }
    : {
        ok: true,
        value: decided
          .filter(({ runs }) => runs === true)
          .map(({ name }) => name),
      };
};

const inputFindings = (
  file: WorkflowFile,
  mode: ModeInput
): readonly string[] => [
  ...(mode.type === "choice"
    ? []
    : [`${file.name} input mode is not a choice`]),
  ...([...mode.options].toSorted().join(",") === [...modes].toSorted().join(",")
    ? []
    : [`${file.name} input mode must offer exactly check and publish`]),
  ...(mode.default === "check"
    ? []
    : [`${file.name} input mode must default to check`]),
];

const reachFindings = (
  file: WorkflowFile,
  workflow: Parsed,
  publishing: readonly string[]
): readonly string[] => {
  const cases = ["check", "publish", "", "other"].flatMap((mode) =>
    [releaseRef, "refs/heads/feature"].map((ref) => ({ mode, ref }))
  );

  return cases.flatMap((run) => {
    const running = jobsRunning(workflow, run);

    if (!running.ok) {
      return [`${file.name}: ${running.problem}`];
    }

    const reached = running.value.filter((name) => publishing.includes(name));
    const mayPublish = run.mode === "publish" && run.ref === releaseRef;
    const findings: string[] = [];

    if (reached.length > 0 && !mayPublish) {
      findings.push(
        `${file.name}: with mode "${run.mode}" on ${run.ref} the job ${reached.join(", ")} runs and holds a publish command`
      );
    }

    if (mayPublish && reached.length === 0) {
      findings.push(
        `${file.name}: with mode "publish" on ${releaseRef} no job publishes`
      );
    }

    return findings;
  });
};

/**
 * Sentences about how the release workflow's `mode` input can reach a publish it should not. Empty when: the workflow
 * dispatches by hand only, with an input `mode` of type `choice` whose options are exactly `check` and `publish` and
 * whose default is `check`; every job has a condition the gate can evaluate or none; and for each mode (and for a mode
 * outside the options, and for a ref that is not `main`) the jobs that run hold a publish command (one without
 * `--dry-run`) only when the mode is `publish` on `main`, and never a job a `check` run could `need`.
 */
export const modeFindings = (file: WorkflowFile): readonly string[] => {
  const parsed = parseWorkflow(file);
  const dispatch = parseDispatch(file);

  if (!parsed.ok || !dispatch.ok) {
    return [
      ...(parsed.ok ? [] : [parsed.problem]),
      ...(dispatch.ok ? [] : [dispatch.problem]),
    ];
  }

  const { jobs } = parsed.value;

  const publishing = Object.keys(jobs).filter((name) =>
    (jobs[name]?.steps ?? []).some((step) => publishes(step.run))
  );

  const needsPublisher = Object.entries(jobs).filter(([, job]) =>
    [job.needs ?? []].flat().some((needed) => publishing.includes(needed))
  );

  return [
    ...inputFindings(file, dispatch.value),
    ...reachFindings(file, parsed.value, publishing),
    ...needsPublisher.map(
      ([name]) =>
        `${file.name}: job ${name} needs a job that publishes, so a run that skips the publisher still depends on it`
    ),
  ];
};

/** The file whose presence holds the release (operator decision). */
const holdFile = ".github/release-hold";

const holdsRelease = (step: Step): boolean =>
  step.run?.includes(holdFile) === true;

/** The script of the hold step, or `undefined` when the workflow has no such step. */
export const holdScript = (file: WorkflowFile): string | undefined => {
  const parsed = parseWorkflow(file);

  return parsed.ok
    ? Object.values(parsed.value.jobs)
        .flatMap((job) => job.steps ?? [])
        .find(holdsRelease)?.run
    : undefined;
};

/** The script of the step called `name` in the job `job`, or `undefined` (a test runs it with stubs for `devenv` and `npm`). */
export const stepScript = (
  file: WorkflowFile,
  job: string,
  name: string
): string | undefined => {
  const parsed = parseWorkflow(file);

  return parsed.ok
    ? parsed.value.jobs[job]?.steps?.find((step) => step.name === name)?.run
    : undefined;
};

const label = (step: Step): string => step.name ?? step.uses ?? "(unnamed)";

const holdBypasses = (
  file: WorkflowFile,
  name: string,
  job: Job,
  held: number
): readonly string[] => {
  const steps = job.steps ?? [];
  const hold = steps[held];
  const findings: string[] = [];

  // A failed hold must stop the job, and no later step may run after it: no continue-on-error, no `if` that can
  // override the failure (`always()`, `failure()`, `!cancelled()`), so no `if` at all.
  if (job["continue-on-error"] !== undefined) {
    findings.push(
      `${file.name}: job ${name} sets continue-on-error, so a failed hold would not stop the publish`
    );
  }

  if (hold?.["continue-on-error"] !== undefined) {
    findings.push(
      `${file.name}: job ${name} sets continue-on-error on the release hold step`
    );
  }

  for (const step of steps.slice(held)) {
    if (step.if !== undefined) {
      findings.push(
        `${file.name}: job ${name} step ${label(step)} has an if, which could run it after the release hold failed`
      );
    }
  }

  return findings;
};

const holdFindingsOf = (
  file: WorkflowFile,
  [name, job]: readonly [string, Job]
): readonly string[] => {
  const steps = job.steps ?? [];

  if (!steps.some((step) => publishes(step.run))) {
    return [];
  }

  const held = steps.findIndex(holdsRelease);

  if (held === -1) {
    return [
      `${file.name}: job ${name} publishes and has no step that tests ${holdFile}`,
    ];
  }

  const early = steps
    .slice(0, held)
    .filter((step) => !(step.uses ?? "").startsWith("actions/checkout@"))
    .map(
      (step) =>
        `${file.name}: job ${name} runs step ${label(step)} before the release hold`
    );

  return [...early, ...holdBypasses(file, name, job, held)];
};

/**
 * Sentences about the release hold. Empty when every job that holds a publish command has a step that tests for
 * `.github/release-hold`, and nothing but the checkout runs before it. (That the script fails while the file exists is
 * run by the test, on the script `holdScript` returns.)
 */
export const holdFindings = (file: WorkflowFile): readonly string[] => {
  const parsed = parseWorkflow(file);

  return parsed.ok
    ? Object.entries(parsed.value.jobs).flatMap((job) =>
        holdFindingsOf(file, job)
      )
    : [parsed.problem];
};

/** The step that makes npm usable in the checkout: `devEngines.packageManager` names Bun and npm refuses with EBADDEVENGINES. */
const removesDevEngines = (step: Step): boolean =>
  step.if === undefined &&
  /(?:^|\n)\s*jq\s[^\n]*del\(\.devEngines\)/u.test(step.run ?? "");

/**
 * Sentences about the `devEngines` removal (spec 0008). Empty when every job that holds a publish command has a step
 * that removes `devEngines` from `package.json` before the first such command: without it npm fails in the checkout,
 * and a publish that fails only on the runner is found out on the first release.
 */
export const engineFindings = (file: WorkflowFile): readonly string[] => {
  const parsed = parseWorkflow(file);

  if (!parsed.ok) {
    return [parsed.problem];
  }

  return Object.entries(parsed.value.jobs).flatMap(([name, job]) => {
    const steps = job.steps ?? [];
    const publishing = steps.findIndex((step) => publishes(step.run));

    if (publishing === -1) {
      return [];
    }

    return steps.slice(0, publishing).some(removesDevEngines)
      ? []
      : [
          `${file.name}: job ${name} publishes and has no step before it that removes devEngines from package.json`,
        ];
  });
};
