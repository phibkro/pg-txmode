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

/** Violations: workspace manifests outside the adapter package that depend on Effect. */
const violations = (
  root: string,
  manifests: readonly string[]
): readonly string[] =>
  manifests
    .filter((manifest) => path.dirname(manifest) !== effectAdapter)
    .flatMap((manifest) =>
      effectDependencies(readFileSync(path.join(root, manifest), "utf-8")).map(
        (name) => `${manifest}: depends on ${name}`
      )
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
});
