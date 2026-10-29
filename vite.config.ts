// Provenance: adapted from reebeat/studio @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8 (vite.config.ts), which adapted it
// from reebeat/reebeat @ f7c348877585f54b6bf00651608726dd7e5044d3 and phibkro/vektorprogrammet-reimagined
// @ 797e9e41d96194b9479ff224ac1c40bbc0545888. Deviations: the Oxlint Effect plugin's rules apply to `packages/effect/**`
// only, because the core and the other packages must not depend on Effect (spec 0003 adds the group, as reebeat @ 82ee66f
// `vite.config.ts` does for its packages). The Effect language-service diagnostics run in `bun run check:effect`, not here:
// `vp check` does not run the `effecttsgo/*` rules (spec 0003, Revisions). See PROVENANCE.md.
import { effect } from "@phibkro/oxlint-effect-plugin";
import type { EffectConfigInput } from "@phibkro/oxlint-effect-plugin";
import ultraciteFmt from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { defineConfig } from "vite-plus";

// Effect roles per path. The Effect adapter is the only package that uses Effect.
const effectConfig: EffectConfigInput = {
  groups: [
    {
      files: ["packages/effect/src/**"],
      platform: "node",
      role: "effect-library",
      strictness: "strict",
    },
    {
      files: ["packages/effect/test/**"],
      platform: "node",
      role: "test",
      strictness: "strict",
    },
    {
      // The two scripts that a test runs in a process of its own (a hung client cannot be interrupted from inside).
      files: [
        "packages/effect/test/finalizerClient.ts",
        "packages/effect/test/m2bClient.ts",
      ],
      platform: "node",
      role: "composition-root",
      strictness: "strict",
    },
    {
      // The one test module that starts those scripts with Node's child-process layer.
      adapterDependencies: ["@effect/platform-node"],
      files: ["packages/effect/test/process.ts"],
      platform: "node",
      role: "runtime-adapter",
      strictness: "strict",
    },
  ],
};

const effectConfigResult = effect(effectConfig);

const restrictedSourcePatterns = [
  {
    message:
      "Import another workspace package through its export map, not its source path.",
    regex: "^@pg-txmode/[^/]+/src(?:/|$)",
  },
  {
    message:
      "Import another workspace package through its export map, not its source path.",
    regex: "^(?:\\./|(?:\\.\\./)+)(?:packages|tools)/[^/]+/src(?:/|$)",
  },
];

export default defineConfig({
  // Prose is written by hand: Oxfmt re-wraps Markdown and joins hard line breaks, which changes meaning.
  fmt: {
    ...ultraciteFmt,
    ignorePatterns: [...(ultraciteFmt.ignorePatterns ?? []), "**/*.md"],
  },
  lint: {
    extends: [core, antiSlop],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "complexity", specifier: "oxlint-plugin-complexity" },
      ...effectConfigResult.jsPlugins,
    ],
    options: { typeAware: true, typeCheck: true },
    overrides: [
      ...effectConfigResult.overrides,
      {
        // For the Effect adapter only. `func-names` asks a name for the generator that `Effect.gen(function* () {})`
        // requires to be anonymous. `promise-function-async` makes a function that returns a promise async, and the
        // language-service diagnostic `asyncFunction` (an error in `tsconfig.json`) forbids every async function; the
        // Effect rule stays. `unicorn/no-array-method-this-argument` misreads Effect's data-first `Arr.every(xs, fn)` as a
        // native `.every(fn, thisArg)` (the diagnostic `preferEffectArray` asks for the data-first form; reebeat switches it
        // off for the same reason).
        files: ["packages/effect/**"],
        rules: {
          "eslint/func-names": "off",
          "typescript/promise-function-async": "off",
          "unicorn/no-array-method-this-argument": "off",
        },
      },
      {
        // `Schema.TaggedError` class definitions read as throw sites to `throw-new-error`, and a closed set of errors (or the
        // two services of the test fixture) reads as one table.
        files: [
          "packages/effect/src/errors.ts",
          "packages/effect/test/stack.ts",
        ],
        rules: {
          "eslint/max-classes-per-file": "off",
          "unicorn/throw-new-error": "off",
        },
      },
      {
        // The harness and every test drive a server through sequential steps: each step waits for the one before it
        // (a transaction's statements, a probe's setup then its observation), and a step that fails is captured with
        // `.then(ok, err)` to be compared, not rethrown. The rules below ask for loops over `await`, for no promise
        // constructor and for no `.then`, which these files cannot satisfy without hiding the order of the steps.
        files: ["packages/harness/**", "**/test/**"],
        rules: {
          "eslint/no-await-in-loop": "off",
          "eslint/no-promise-executor-return": "off",
          "node/callback-return": "off",
          "promise/avoid-new": "off",
          "promise/prefer-await-to-callbacks": "off",
          "promise/prefer-await-to-then": "off",
          "unicorn/no-array-reduce": "off",
        },
      },
      {
        // The lint reads a parse tree: JSON whose shape is known only at the edges, so `typeof` on a JSON value is the
        // parse-at-the-boundary the rule asks for; a cursor's options are a bitmask (CURSOR_OPT_HOLD in the PostgreSQL
        // source), and the tree is passed as `object` to the one function that turns it into JSON.
        files: ["packages/lint/src/**"],
        rules: {
          "anti-slop/no-object-parameters": "off",
          "anti-slop/no-runtime-typeof": "off",
          "eslint/no-bitwise": "off",
        },
      },
      {
        // Test fixtures hold JavaScript source as text, and a template placeholder in that text is the point.
        files: ["**/test/**"],
        rules: { "eslint/no-template-curly-in-string": "off" },
      },
    ],
    rules: {
      "complexity/complexity": ["error", { cognitive: 15 }],
      // `typescript/promise-function-async` (on) makes a function that returns a promise async, and `require-await` then
      // rejects it for having no await. One of the two has to give; the typed one stays.
      "eslint/require-await": "off",
      "no-restricted-imports": [
        "error",
        { patterns: [...restrictedSourcePatterns] },
      ],
      // Workspace modules use lower camelCase filenames.
      "unicorn/filename-case": ["error", { case: "camelCase" }],
      // `(await query(sql))[0]` reads as it is; the rule asks for a temporary that carries no meaning.
      "unicorn/no-await-expression-member": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
  run: { cache: true },
  staged: { "*": "vp check --fix" },
});
