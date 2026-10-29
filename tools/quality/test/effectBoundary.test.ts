import { globSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";

import { repoRoot, withScratch, writeFixture } from "./scriptHarness.ts";

// AGENTS.md, "Stack": the core does not depend on Effect; only the Effect adapter package may.
const effectAdapter = "packages/effect";

const Manifest = z.object({
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
  name: z.string(),
  optionalDependencies: z.record(z.string(), z.string()).default({}),
  peerDependencies: z.record(z.string(), z.string()).default({}),
});

const isEffectPackage = (name: string): boolean =>
  name === "effect" || name.startsWith("@effect/");

/** Names a manifest's Effect dependencies, in every dependency field. */
const effectDependencies = (source: string): readonly string[] => {
  const manifest = Manifest.parse(JSON.parse(source));

  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ].flatMap((fields) => Object.keys(fields).filter(isEffectPackage));
};

/**
 * The one Effect package that the repository root may list: `@effect/tsgo`, the checker that `vp check` and the `prepare`
 * script run over the adapter (its language-service diagnostics and lint presets). It is tooling, not a dependency of
 * any package's code, and it is named here so that nothing else slips in beside it.
 */
const rootTooling = "@effect/tsgo";

/** Violations: workspace manifests outside the adapter package that depend on Effect. */
const violations = (
  root: string,
  manifests: readonly string[]
): readonly string[] =>
  manifests
    .filter((manifest) => path.dirname(manifest) !== effectAdapter)
    .flatMap((manifest) =>
      effectDependencies(readFileSync(path.join(root, manifest), "utf-8"))
        .filter(
          (name) => !(manifest === "package.json" && name === rootTooling)
        )
        .map((name) => `${manifest}: depends on ${name}`)
    );

const workspaceManifests = (root: string): readonly string[] => [
  "package.json",
  ...globSync("{packages,tools}/*/package.json", { cwd: root }),
];

describe("Effect boundary", () => {
  test("no workspace package outside the Effect adapter depends on Effect", () => {
    expect(violations(repoRoot, workspaceManifests(repoRoot))).toStrictEqual(
      []
    );
  });

  test("control: a manifest that depends on effect or an @effect package is reported", () => {
    const found = withScratch((root) => {
      writeFixture(
        path.join(root, "packages/core/package.json"),
        JSON.stringify({ dependencies: { effect: "4.1.0" }, name: "core" })
      );
      writeFixture(
        path.join(root, "tools/quality/package.json"),
        JSON.stringify({
          devDependencies: { "@effect/vitest": "4.1.0" },
          name: "quality",
        })
      );

      return violations(root, [
        "packages/core/package.json",
        "tools/quality/package.json",
      ]);
    });

    expect(found).toStrictEqual([
      "packages/core/package.json: depends on effect",
      "tools/quality/package.json: depends on @effect/vitest",
    ]);
  });

  test("control: the Effect adapter package may depend on Effect", () => {
    const found = withScratch((root) => {
      writeFixture(
        path.join(root, `${effectAdapter}/package.json`),
        JSON.stringify({ dependencies: { effect: "4.1.0" }, name: "adapter" })
      );

      return violations(root, [`${effectAdapter}/package.json`]);
    });

    expect(found).toStrictEqual([]);
  });

  test("control: the root may list the checker @effect/tsgo and nothing else from Effect; a package may not list the checker", () => {
    const found = withScratch((root) => {
      writeFixture(
        path.join(root, "package.json"),
        JSON.stringify({
          devDependencies: { "@effect/tsgo": "0.63.0", effect: "4.1.0" },
          name: "root",
        })
      );
      writeFixture(
        path.join(root, "packages/lint/package.json"),
        JSON.stringify({
          devDependencies: { "@effect/tsgo": "0.63.0" },
          name: "lint",
        })
      );

      return violations(root, ["package.json", "packages/lint/package.json"]);
    });

    expect(found).toStrictEqual([
      "package.json: depends on effect",
      "packages/lint/package.json: depends on @effect/tsgo",
    ]);
  });
});

/** A module specifier that names Effect: `effect`, `effect/...`, `@effect/...` (static, dynamic and type imports, `require`). */
const effectSpecifier =
  /(?:from|import|require)\s*\(?\s*["'](?:effect(?:\/[^"']*)?|@effect\/[^"']*)["']/u;

/** This file holds fixtures that import Effect on purpose; it is the one file the scan skips. */
const self = "tools/quality/test/effectBoundary.test.ts";

const sourceFiles = (root: string, pattern: string): readonly string[] =>
  globSync(pattern, { cwd: root }).filter(
    (file) => !file.includes("node_modules/")
  );

/** Every TypeScript file outside the Effect adapter that imports Effect. */
const importers = (root: string): readonly string[] =>
  sourceFiles(root, "{packages,tools}/**/*.ts")
    .filter((file) => !file.startsWith(`${effectAdapter}/`) && file !== self)
    .filter((file) =>
      effectSpecifier.test(readFileSync(path.join(root, file), "utf-8"))
    );

describe("Effect boundary, source level", () => {
  test("no TypeScript file outside the Effect adapter imports Effect", () => {
    expect(importers(repoRoot)).toStrictEqual([]);
  });

  test("control: an import of effect, of an @effect package or of an effect subpath is found, and a word in a string or comment is not", () => {
    const found = withScratch((root) => {
      writeFixture(
        path.join(root, "packages/core/src/a.ts"),
        'import { Effect } from "effect";\n'
      );
      writeFixture(
        path.join(root, "packages/pg/src/b.ts"),
        'import { SqlClient } from "effect/sql";\n'
      );
      writeFixture(
        path.join(root, "tools/quality/c.ts"),
        'const sql = await import("@effect/sql-pg");\n'
      );
      writeFixture(
        path.join(root, "packages/lint/src/d.ts"),
        '// the effect of a lint\nexport const word = "effect";\nimport { x } from "effects-of-war";\n'
      );
      writeFixture(
        path.join(root, `${effectAdapter}/src/e.ts`),
        'import { Effect } from "effect";\n'
      );

      return [...importers(root)].toSorted();
    });

    expect(found).toStrictEqual([
      "packages/core/src/a.ts",
      "packages/pg/src/b.ts",
      "tools/quality/c.ts",
    ]);
  });
});

/**
 * The Effect adapter is published source: no directive may switch a diagnostic off in it, and no registry entry may excuse
 * one. (Oxlint, ESLint and TypeScript directives are the exception registry's; these are the Effect language service's and
 * the Oxlint Effect plugin's, which have no registry.)
 */
const directive =
  /@effect-(?:diagnostics|expect-error)|oxlint-effect-plugin\s+(?:allow|ignore-file)|oxlint-disable|eslint-disable|@ts-(?:ignore|expect-error|nocheck)/u;

const directives = (root: string): readonly string[] =>
  sourceFiles(root, `${effectAdapter}/{src,test}/**/*.ts`).filter((file) =>
    directive.test(readFileSync(path.join(root, file), "utf-8"))
  );

describe("the Effect adapter carries no suppression directive", () => {
  test("packages/effect has none", () => {
    expect(directives(repoRoot)).toStrictEqual([]);
  });

  test("control: each kind of directive is found in a source file", () => {
    const found = withScratch((root) => {
      const kinds = [
        "// @effect-diagnostics-next-line effect/unknownInEffectCatch:off",
        "/** @effect-expect-error floatingEffect */",
        "// oxlint-effect-plugin allow(no-ambient-console):",
        "// oxlint-disable-next-line no-console",
        "// @ts-expect-error",
      ];

      for (const [index, kind] of kinds.entries()) {
        writeFixture(
          path.join(root, `${effectAdapter}/src/f${index}.ts`),
          `${kind}\nexport const x = ${index};\n`
        );
      }

      writeFixture(
        path.join(root, `${effectAdapter}/src/clean.ts`),
        "export const y = 1;\n"
      );

      return directives(root).length;
    });

    expect(found).toBe(5);
  });
});

/**
 * The adapter derives what a mode can do from the core's catalogue and mode record. It names no pooler and reads no
 * pooler setting, so a fact about a pooler has one home.
 */
const poolerKnowledge =
  /\.pooler\b|\.maxPreparedStatements\b|["'`](?:hyperdrive|pgbouncer|supavisor|neon)["'`]/u;

const knowing = (root: string): readonly string[] =>
  sourceFiles(root, `${effectAdapter}/src/**/*.ts`).filter((file) =>
    poolerKnowledge.test(readFileSync(path.join(root, file), "utf-8"))
  );

describe("the Effect adapter has no second copy of a pooler fact", () => {
  test("packages/effect/src reads no pooler name and no pooler setting", () => {
    expect(knowing(repoRoot)).toStrictEqual([]);
  });

  test("control: a pooler name, a pooler field and a pooler setting are found", () => {
    const found = withScratch((root) => {
      writeFixture(
        path.join(root, `${effectAdapter}/src/a.ts`),
        'export const named = mode.pooler === "hyperdrive";\n'
      );
      writeFixture(
        path.join(root, `${effectAdapter}/src/b.ts`),
        "export const tracked = mode.maxPreparedStatements > 0;\n"
      );
      writeFixture(
        path.join(root, `${effectAdapter}/src/c.ts`),
        'export const kind = mode.kind === "TransactionPooled";\n'
      );

      return [...knowing(root)].toSorted();
    });

    expect(found).toStrictEqual([
      `${effectAdapter}/src/a.ts`,
      `${effectAdapter}/src/b.ts`,
    ]);
  });
});
