// The release rules (spec 0006): which packages are published, the manifest that ships for each, what a tarball may hold,
// and that Changesets knows exactly the published set. Each rule has a control that breaks it in a fixture, and each
// runs on the real manifests.
// Provenance: follows tsukuri-labs/tsukuri spec 0009 (tools/quality/test/release.test.ts, PR #29, merge commit
// d0c5a1de330200302edbad58784f351b09eeb4f8), in Vitest and for this repository's packages. See PROVENANCE.md.
import { globSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";

import {
  importFindings,
  ManifestSchema,
  publishedPackages,
  releaseManifest,
  RootSchema,
  strayFiles,
  unboundedPeers,
  unpublishedDependencies,
} from "../release.ts";
import type {
  Context,
  Manifest,
  PackageEntry,
  RootManifest,
} from "../release.ts";
import { repoRoot, runBash } from "./scriptHarness.ts";

const readJson = <T>(file: string, schema: z.ZodType<T>): T =>
  schema.parse(JSON.parse(readFileSync(path.join(repoRoot, file), "utf-8")));

const workspace: readonly PackageEntry[] = globSync("packages/*/package.json", {
  cwd: repoRoot,
})
  .toSorted()
  .map((file) => ({
    dir: path.dirname(file),
    manifest: readJson(file, ManifestSchema),
  }));

const root: RootManifest = readJson("package.json", RootSchema);

const published = publishedPackages(workspace);
const publishedNames = published.map((entry) => entry.manifest.name).toSorted();

const context: Context = {
  catalog: root.catalog,
  versions: new Map(
    published.map((entry) => [entry.manifest.name, entry.manifest.version])
  ),
};

/** A published package in the shape of the real ones, with the fields a control changes. */
const fixture = (changes: Partial<Manifest>): PackageEntry => ({
  dir: "packages/probe",
  manifest: {
    dependencies: {},
    description: "A probe.",
    devDependencies: {},
    exports: { ".": "./src/index.ts" },
    license: "Apache-2.0",
    name: "@probe/probe",
    peerDependencies: {},
    publishConfig: { access: "public", directory: "dist" },
    version: "1.0.0",
    ...changes,
  },
});

const problems = (entry: PackageEntry): readonly string[] => {
  const staged = releaseManifest(entry, root, context);

  return staged.ok ? [] : staged.problems;
};

const mentions =
  (text: string) =>
  (lines: readonly string[]): boolean =>
    lines.some((line) => line.includes(text));

const ChangesetConfig = z.object({
  access: z.string(),
  fixed: z.array(z.array(z.string())),
});

const Pre = z.object({ mode: z.string(), tag: z.string() });

describe("which packages are published", () => {
  test("core, pg, effect, lint and the harness; the repository tooling stays private", () => {
    expect(publishedNames).toStrictEqual([
      "@pg-txmode/core",
      "@pg-txmode/effect",
      "@pg-txmode/harness",
      "@pg-txmode/lint",
      "@pg-txmode/pg",
    ]);
    expect(
      workspace.flatMap((entry) =>
        entry.manifest.private === true ? [entry.manifest.name] : []
      )
    ).toStrictEqual([]);
  });

  test("Changesets versions exactly the published set, in lockstep, as public alpha prereleases", () => {
    const config = readJson(".changeset/config.json", ChangesetConfig);
    const pre = readJson(".changeset/pre.json", Pre);

    expect(config.access).toBe("public");
    expect(config.fixed.map((group) => [...group].toSorted())).toStrictEqual([
      publishedNames,
    ]);
    expect(pre).toStrictEqual({ mode: "pre", tag: "alpha" });
  });

  test("no published package depends on one that is not published (control)", () => {
    const names = new Set(workspace.map((entry) => entry.manifest.name));
    const publishedSet = new Set(publishedNames);

    for (const entry of published) {
      expect(unpublishedDependencies(entry, publishedSet, names)).toStrictEqual(
        []
      );
    }

    // A workspace package that is private (none is, today): the fixture adds one to the workspace names.
    expect(
      unpublishedDependencies(
        fixture({
          dependencies: { "@pg-txmode/private-probe": "workspace:*" },
        }),
        publishedSet,
        new Set([...names, "@pg-txmode/private-probe"])
      )
    ).toStrictEqual(["@pg-txmode/private-probe"]);
  });
});

describe("the manifest that ships", () => {
  test("every published package builds a clean manifest: no workspace: or catalog: left, the licence, public access", () => {
    for (const entry of published) {
      const staged = releaseManifest(entry, root, context);

      expect(staged.ok).toBe(true);

      if (staged.ok) {
        const text = JSON.stringify(staged.manifest);

        expect(text).not.toMatch(/workspace:|catalog:/u);
        expect(staged.manifest.license).toBe("Apache-2.0");
        expect(staged.manifest.publishConfig).toStrictEqual({
          access: "public",
        });
        expect(JSON.stringify(staged.manifest.exports)).not.toContain(".ts");
      }
    }
  });

  test("rewrites workspace:* to the version and catalog: to the catalog's, and puts types before default", () => {
    const staged = releaseManifest(
      fixture({
        dependencies: {
          "@pg-txmode/core": "workspace:*",
          zod: "catalog:",
        },
        exports: { ".": "./src/index.ts", "./cancel": "./src/cancel.ts" },
      }),
      root,
      context
    );

    expect(staged.ok).toBe(true);

    if (staged.ok) {
      expect(staged.manifest.dependencies).toStrictEqual({
        "@pg-txmode/core": context.versions.get("@pg-txmode/core"),
        zod: `^${root.catalog.zod}`,
      });
      expect(
        Object.keys(staged.manifest.exports["./cancel"] ?? {})
      ).toStrictEqual(["types", "default"]);
      expect(staged.manifest.exports["./cancel"]).toStrictEqual({
        default: "./cancel.mjs",
        types: "./cancel.d.mts",
      });
    }
  });

  test("ships the bin as npm stores it, and library ranges as carets with the lockstep packages exact", () => {
    const lint = published.find(
      (entry) => entry.manifest.name === "@pg-txmode/lint"
    );

    const staged = releaseManifest(lint ?? fixture({}), root, context);

    expect(staged.ok).toBe(true);

    if (staged.ok) {
      expect(staged.manifest.bin).toStrictEqual({
        "pg-txmode-lint": "cli.mjs",
      });

      for (const [name, range] of Object.entries(
        staged.manifest.dependencies ?? {}
      )) {
        expect(range).toBe(
          name.startsWith("@pg-txmode/")
            ? context.versions.get(name)
            : `^${root.catalog[name]}`
        );
      }
    }
  });

  test("fails a dependency that npm cannot resolve (controls)", () => {
    expect(
      mentions("is workspace:* but is not a published package")(
        problems(
          fixture({
            dependencies: { "@pg-txmode/private-probe": "workspace:*" },
          })
        )
      )
    ).toBe(true);
    expect(
      mentions("is catalog: but not in the catalog")(
        problems(fixture({ dependencies: { nothing: "catalog:" } }))
      )
    ).toBe(true);
    expect(
      mentions("which npm cannot resolve")(
        problems(fixture({ dependencies: { zod: "workspace:^" } }))
      )
    ).toBe(true);
    expect(
      mentions("which npm cannot resolve")(
        problems(fixture({ peerDependencies: { zod: "catalog:default" } }))
      )
    ).toBe(true);
  });

  test("fails a missing licence, description or public access, a source file that is not .ts, and a name clash (controls)", () => {
    expect(mentions("license is")(problems(fixture({ license: "MIT" })))).toBe(
      true
    );
    expect(
      mentions("description is missing")(
        problems(fixture({ description: undefined }))
      )
    ).toBe(true);
    expect(
      mentions("publishConfig.access")(
        problems(fixture({ publishConfig: { directory: "dist" } }))
      )
    ).toBe(true);
    expect(
      mentions("publishConfig.directory")(
        problems(fixture({ publishConfig: { access: "public" } }))
      )
    ).toBe(true);
    expect(
      mentions("not a ./src/*.ts file")(
        problems(fixture({ exports: { ".": "./index.js" } }))
      )
    ).toBe(true);
    expect(
      mentions("would both build to index.mjs")(
        problems(
          fixture({
            exports: { ".": "./src/index.ts", "./other": "./src/x/index.ts" },
          })
        )
      )
    ).toBe(true);
    expect(
      mentions("is not a plain version")(
        problems(fixture({ version: "workspace:*" }))
      )
    ).toBe(true);
  });

  test("a published package refuses to be published from its source directory", () => {
    for (const entry of published) {
      const script = readJson(
        path.join(entry.dir, "package.json"),
        z.object({ scripts: z.object({ prepublishOnly: z.string() }) })
      ).scripts.prepublishOnly;

      expect(runBash(["-c", script], {}, repoRoot).exitCode).toBe(1);
    }
  });
});

const listing = (...files: readonly string[]) => [
  { files: files.map((file) => ({ path: file })) },
];

describe("what a tarball may hold", () => {
  test("built output, the manifest and the documents only", () => {
    expect(
      strayFiles(
        listing(
          "index.mjs",
          "index.d.mts",
          "extract-D8E.mjs",
          "package.json",
          "README.md",
          "CHANGELOG.md",
          "LICENSE",
          "NOTICE"
        )
      )
    ).toStrictEqual([]);
  });

  test("fails source, tests, maps, build info and nested files (controls)", () => {
    expect(
      strayFiles(
        listing(
          "index.mjs",
          "src/index.ts",
          "index.mjs.map",
          "test/x.test.ts",
          "tsconfig.tsbuildinfo",
          "nested/index.mjs",
          ".npmrc"
        )
      )
    ).toStrictEqual([
      "src/index.ts",
      "index.mjs.map",
      "test/x.test.ts",
      "tsconfig.tsbuildinfo",
      "nested/index.mjs",
      ".npmrc",
    ]);
  });
});

const built = (name: string, text: string) => [{ name, text }];

describe("what a built file may import", () => {
  const { manifest } = fixture({
    dependencies: { "@types/pg": "8.0.0", pg: "8.0.0", zod: "4.0.0" },
    devDependencies: { "@types/node": "1.0.0" },
    peerDependencies: { peerlib: ">=1.0.0 <2.0.0" },
  });

  test("declared packages, subpaths, relative and node: imports are fine", () => {
    expect(
      importFindings(
        manifest,
        built(
          "index.mjs",
          'import { z } from "zod";\nimport { a } from "peerlib/sub/path";\nimport x from "./chunk-1.mjs";\nimport fs from "node:fs";\nconst m = await import("pg");'
        )
      )
    ).toStrictEqual([]);
  });

  test("fails a bare import that is not a dependency or a peer (control)", () => {
    expect(
      importFindings(
        manifest,
        built(
          "index.mjs",
          'import { x } from "left-pad";\nimport y from "@scope/lib/sub";'
        )
      )
    ).toStrictEqual([
      "@probe/probe: index.mjs imports left-pad, which is not in dependencies or peerDependencies",
      "@probe/probe: index.mjs imports @scope/lib, which is not in dependencies or peerDependencies",
    ]);
  });

  test("fails declarations whose types come from a development dependency, imported or augmented (control)", () => {
    const typed = fixture({
      dependencies: { pg: "8.0.0" },
      devDependencies: { "@types/pg": "8.0.0" },
    }).manifest;

    const finding =
      "@probe/probe: index.d.mts imports pg, and its types @types/pg are a devDependency, which does not ship";

    // `declare module "pg"` is how the harness's declarations add `processID` and `secretKey` to node-postgres' Client.
    for (const text of [
      'import { Pool } from "pg";',
      'declare module "pg" { interface Client {} }',
    ]) {
      expect(importFindings(typed, built("index.d.mts", text))).toStrictEqual([
        finding,
      ]);
      expect(importFindings(typed, built("index.mjs", text))).toStrictEqual([]);
      expect(
        importFindings(manifest, built("index.d.mts", text))
      ).toStrictEqual([]);
    }
  });

  test("maps a scoped package to its types name", () => {
    const scoped = fixture({
      dependencies: { "@scope/lib": "1.0.0" },
      devDependencies: { "@types/scope__lib": "1.0.0" },
    }).manifest;

    expect(
      importFindings(
        scoped,
        built("index.d.mts", 'import { a } from "@scope/lib/sub";')
      )
    ).toStrictEqual([
      "@probe/probe: index.d.mts imports @scope/lib, and its types @types/scope__lib are a devDependency, which does not ship",
    ]);
  });
});

describe("the Effect peer range", () => {
  const effectPackage = workspace.find(
    (entry) => entry.manifest.name === "@pg-txmode/effect"
  );

  test("a package that uses unstable Effect APIs bounds its peers below the next minor", () => {
    const tsconfig = readFileSync(
      path.join(repoRoot, "packages/effect/tsconfig.json"),
      "utf-8"
    );

    // The adapter lists unstable APIs it uses in allowedUnstableApis (checked by `bun run check:effect`).
    expect(tsconfig).toMatch(/"allowedUnstableApis":\s*\[\s*"/u);
    expect(effectPackage).toBeDefined();
    expect(
      Object.keys(effectPackage?.manifest.peerDependencies ?? {})
    ).toContain("effect");
    expect(
      unboundedPeers(effectPackage?.manifest ?? fixture({}).manifest)
    ).toStrictEqual([]);
  });

  test("fails a caret or open range on a package that uses unstable APIs (controls)", () => {
    expect(
      unboundedPeers(
        fixture({ peerDependencies: { effect: "^4.1.0" } }).manifest
      )
    ).toStrictEqual(["effect"]);
    expect(
      unboundedPeers(
        fixture({ peerDependencies: { effect: ">=4.1.0" } }).manifest
      )
    ).toStrictEqual(["effect"]);
    expect(
      unboundedPeers(
        fixture({
          peerDependencies: { effect: ">=4.1.0 <4.2.0", other: "~1.2.0" },
        }).manifest
      )
    ).toStrictEqual([]);
  });
});

describe("what ships with every package", () => {
  test("the repository has the licence and the notice that stage copies", () => {
    expect(readFileSync(path.join(repoRoot, "NOTICE"), "utf-8")).toContain(
      "Copyright 2026 Philip Bjørknes Krogh"
    );
    expect(readFileSync(path.join(repoRoot, "LICENSE"), "utf-8")).toContain(
      "Apache License"
    );
  });

  test("the harness README ships and names every binary it spawns and the cleanup it does (control: the generated README names none)", () => {
    const required = [
      "initdb",
      "postgres",
      "createdb",
      "pgbouncer",
      "fsync=off",
      "SIGKILL",
      "watchdog",
    ];

    const missing = (text: string): readonly string[] =>
      required.filter((word) => !text.includes(word));

    expect(
      missing(
        readFileSync(path.join(repoRoot, "packages/harness/README.md"), "utf-8")
      )
    ).toStrictEqual([]);
    // What stage writes for a package without a README of its own: the description only.
    expect(
      missing("# @pg-txmode/harness\n\nTest tool of pg-txmode.\n")
    ).toStrictEqual(required);
  });
});
