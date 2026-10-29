// Provenance: adapted from reebeat/studio @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8 (vite.config.ts), which adapted it
// from reebeat/reebeat @ f7c348877585f54b6bf00651608726dd7e5044d3 and phibkro/vektorprogrammet-reimagined
// @ 797e9e41d96194b9479ff224ac1c40bbc0545888. Deviations: no Effect, Foldkit or anti-slop Effect rules (the core must not
// depend on Effect; the Effect adapter package adds its own group in its spec). See PROVENANCE.md.
import ultraciteFmt from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { defineConfig } from "vite-plus";

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
    ],
    options: { typeAware: true, typeCheck: true },
    overrides: [
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
