// The release rules of spec 0006, as pure functions over manifests: which packages are published, the manifest that
// ships for each, and what a tarball may hold. `stagePackages.ts` does the file work; `test/release.test.ts` runs these
// on fixtures and on the real manifests. Plain TypeScript (no Effect), like the rest of tools/.
// Original code. The design (a generated manifest in `dist`, `publishConfig.directory`, an `npm pack --dry-run --json`
// allowlist, `workspace:` and `catalog:` rewriting) follows the decisions of tsukuri-labs/tsukuri spec 0009 (PR #29,
// merge commit d0c5a1de330200302edbad58784f351b09eeb4f8; its spec and tests were read, its `release.ts` was not).
// See PROVENANCE.md.
import path from "node:path";

import { z } from "zod";

const text = z.string().min(1);
const stringMap = z.record(text, z.string());

export const ManifestSchema = z.object({
  bin: z.record(text, text).optional(),
  dependencies: stringMap.default({}),
  description: text.optional(),
  devDependencies: stringMap.default({}),
  exports: z.record(text, text).optional(),
  license: text.optional(),
  name: text,
  peerDependencies: stringMap.default({}),
  private: z.boolean().optional(),
  publishConfig: z
    .object({ access: text.optional(), directory: text.optional() })
    .optional(),
  version: text,
});

export type Manifest = z.infer<typeof ManifestSchema>;

/** A workspace package: where it lives (relative to the root) and its source manifest. */
export interface PackageEntry {
  readonly dir: string;
  readonly manifest: Manifest;
}

/** The root `package.json` fields a published manifest takes. */
export const RootSchema = z.object({
  bugs: text,
  catalog: stringMap.default({}),
  homepage: text,
  license: text,
  repository: z.object({ type: text, url: text }),
});

export type RootManifest = z.infer<typeof RootSchema>;

/** A package is published when its manifest is not `private` (the Changesets rule): the one source of the set. */
export const publishedPackages = (
  entries: readonly PackageEntry[]
): readonly PackageEntry[] =>
  entries.filter((entry) => entry.manifest.private !== true);

const stem = (source: string): string =>
  path.basename(source, path.extname(source));

/** Where a source file of a package lands in `dist`: its base name, as `.mjs` (`./src/cancel.ts` -> `cancel.mjs`). */
export const builtFile = (source: string): string => `${stem(source)}.mjs`;

/** The source files `vp pack` must build: the targets of `exports` and of `bin`, once each. */
export const entryPoints = (manifest: Manifest): readonly string[] => [
  ...new Set([
    ...Object.values(manifest.exports ?? {}),
    ...Object.values(manifest.bin ?? {}),
  ]),
];

/** The context a manifest is rewritten in: the root catalog and the version of every published package. */
export interface Context {
  readonly catalog: Readonly<Record<string, string>>;
  readonly versions: ReadonlyMap<string, string>;
}

interface Rewritten {
  readonly problems: readonly string[];
  readonly rewritten: Readonly<Record<string, string>>;
}

interface Rewrite {
  readonly problem?: string;
  readonly value?: string;
}

const rewriteOne = (name: string, range: string, context: Context): Rewrite => {
  if (range === "workspace:*") {
    const version = context.versions.get(name);

    return version === undefined
      ? { problem: `${name} is workspace:* but is not a published package` }
      : { value: version };
  }

  if (range === "catalog:") {
    const version = context.catalog[name];

    return version === undefined
      ? { problem: `${name} is catalog: but not in the catalog` }
      : { value: /^\d/u.test(version) ? `^${version}` : version };
  }

  return range.startsWith("workspace:") || range.startsWith("catalog:")
    ? { problem: `${name} has the range ${range}, which npm cannot resolve` }
    : { value: range };
};

const rewriteDependencies = (
  dependencies: Readonly<Record<string, string>>,
  context: Context
): Rewritten => {
  const rewritten: Record<string, string> = {};
  const problems: string[] = [];

  for (const [name, range] of Object.entries(dependencies)) {
    const { problem, value } = rewriteOne(name, range, context);

    if (problem !== undefined) {
      problems.push(`dependency ${problem}`);
    } else if (value !== undefined) {
      rewritten[name] = value;
    }
  }

  return { problems, rewritten };
};

interface MappedExports {
  readonly mapped: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly problems: readonly string[];
}

/** `types` before `default`: TypeScript takes the first condition that matches, and `default` matches everything. */
const condition = (source: string): Readonly<Record<string, string>> =>
  Object.fromEntries([
    ["types", `./${stem(source)}.d.mts`],
    ["default", `./${builtFile(source)}`],
  ]);

const mapExports = (manifest: Manifest): MappedExports => {
  const mapped: Record<string, Readonly<Record<string, string>>> = {};
  const seen = new Map<string, string>();
  const problems: string[] = [];

  for (const [key, source] of Object.entries(manifest.exports ?? {})) {
    const built = builtFile(source);
    const previous = seen.get(built);

    if (!source.startsWith("./src/") || !source.endsWith(".ts")) {
      problems.push(`export ${key} is ${source}, not a ./src/*.ts file`);
    } else if (previous !== undefined && previous !== source) {
      problems.push(`${source} and ${previous} would both build to ${built}`);
    } else {
      seen.set(built, source);
      mapped[key] = condition(source);
    }
  }

  return { mapped, problems };
};

const manifestProblems = (
  manifest: Manifest,
  root: RootManifest
): readonly string[] => [
  ...(manifest.license === root.license
    ? []
    : [
        `license is ${manifest.license ?? "missing"}, the repository's is ${root.license}`,
      ]),
  ...(manifest.description === undefined ? ["description is missing"] : []),
  ...(manifest.publishConfig?.access === "public"
    ? []
    : ['publishConfig.access must be "public"']),
  ...(manifest.publishConfig?.directory === "dist"
    ? []
    : ['publishConfig.directory must be "dist"']),
  ...(Object.keys(manifest.exports ?? {}).length === 0
    ? ["exports is empty"]
    : []),
  ...(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)
    ? []
    : [`version ${manifest.version} is not a plain version`]),
];

/** The manifest that ships in `dist`. */
export interface ShippedManifest {
  bin?: Record<string, string>;
  bugs: string;
  dependencies?: Readonly<Record<string, string>>;
  description: string;
  exports: Readonly<Record<string, Readonly<Record<string, string>>>>;
  homepage: string;
  license: string;
  name: string;
  peerDependencies?: Readonly<Record<string, string>>;
  publishConfig: { access: "public" };
  repository: { directory: string; type: string; url: string };
  type: "module";
  version: string;
}

export type Staged =
  | { readonly ok: true; readonly manifest: ShippedManifest }
  | { readonly ok: false; readonly problems: readonly string[] };

const nonEmpty = (map: Readonly<Record<string, string>>): boolean =>
  Object.keys(map).length > 0;

/**
 * The `package.json` that ships in `dist` for one published package, or every problem that stops it: a `workspace:`
 * range to a package that is not published, a `catalog:` name the catalog lacks, an export that is not a source file,
 * a missing licence, description or `access: public`. `devDependencies` and `scripts` do not ship.
 */
export const releaseManifest = (
  entry: PackageEntry,
  root: RootManifest,
  context: Context
): Staged => {
  const { manifest } = entry;
  const dependencies = rewriteDependencies(manifest.dependencies, context);
  const peers = rewriteDependencies(manifest.peerDependencies, context);
  const exportsMap = mapExports(manifest);

  const problems = [
    ...manifestProblems(manifest, root),
    ...dependencies.problems,
    ...peers.problems.map((problem) => problem.replace("dependency", "peer")),
    ...exportsMap.problems,
  ];

  if (problems.length > 0) {
    return {
      ok: false,
      problems: problems.map((problem) => `${manifest.name}: ${problem}`),
    };
  }

  const shipped: ShippedManifest = {
    bugs: root.bugs,
    description: manifest.description ?? "",
    exports: exportsMap.mapped,
    homepage: root.homepage,
    license: root.license,
    name: manifest.name,
    publishConfig: { access: "public" },
    repository: { ...root.repository, directory: entry.dir },
    type: "module",
    version: manifest.version,
  };

  if (manifest.bin !== undefined) {
    shipped.bin = Object.fromEntries(
      Object.entries(manifest.bin).map(([name, source]) => [
        name,
        // npm stores `bin` without the leading `./` and warns that it "corrected" a manifest that has one.
        builtFile(source),
      ])
    );
  }

  if (nonEmpty(dependencies.rewritten)) {
    shipped.dependencies = dependencies.rewritten;
  }

  if (nonEmpty(peers.rewritten)) {
    shipped.peerDependencies = peers.rewritten;
  }

  return { manifest: shipped, ok: true };
};

/** Files that may be in a tarball: built output, the generated manifest, the documents. */
const allowedFile =
  /^(?:[^/]+\.mjs|[^/]+\.d\.mts|package\.json|README\.md|CHANGELOG\.md|LICENSE|NOTICE)$/u;

/** The `npm pack --dry-run --json` listing. */
export const PackListingSchema = z.array(
  z.object({ files: z.array(z.object({ path: text })) })
);

export type PackListing = z.infer<typeof PackListingSchema>;

/** The files of a tarball that are not built output. */
export const strayFiles = (listing: PackListing): readonly string[] =>
  listing.flatMap((pack) =>
    pack.files
      .map((file) => file.path)
      .filter((file) => !allowedFile.test(file))
  );

/** The workspace packages that a published package lists in `dependencies` or `peerDependencies` but does not publish. */
export const unpublishedDependencies = (
  entry: PackageEntry,
  published: ReadonlySet<string>,
  workspace: ReadonlySet<string>
): readonly string[] =>
  Object.keys({
    ...entry.manifest.dependencies,
    ...entry.manifest.peerDependencies,
  }).filter((name) => workspace.has(name) && !published.has(name));

/**
 * Peers whose range has no upper bound below the next minor. A package that lists unstable APIs in its language-service
 * configuration must bound its peers (`>=4.1.0 <4.2.0` or `~4.1.0`): an `@stability unstable` Effect API may break in a
 * minor release. One that lists none may use a caret.
 */
export const unboundedPeers = (manifest: Manifest): readonly string[] =>
  Object.entries(manifest.peerDependencies)
    .filter(
      ([, range]) =>
        !(/<\s*\d+\.\d+\.\d+/u.test(range) || range.startsWith("~"))
    )
    .map(([name]) => name);

/** A built file of a package: its name in `dist` and its text. */
export interface BuiltFile {
  readonly name: string;
  readonly text: string;
}

const importSpecifier = /\b(?:from|import\()\s*["'](?<specifier>[^"']+)["']/gu;

/** The package a bare import specifier names (`@scope/name/sub` is `@scope/name`); relative and `node:` imports are none. */
const packageOf = (specifier: string): string | undefined => {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) {
    return undefined;
  }

  const parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

/** `pg` -> `@types/pg`, `@scope/name` -> `@types/scope__name`. */
const typesPackage = (name: string): string =>
  `@types/${name.replace(/^@(?<scope>[^/]+)\//u, "$<scope>__")}`;

const importedPackages = (file: BuiltFile): readonly string[] => [
  ...new Set(
    [...file.text.matchAll(importSpecifier)].flatMap(({ groups }) => {
      const name = packageOf(groups?.specifier ?? ".");

      return name === undefined ? [] : [name];
    })
  ),
];

/**
 * What a built file imports that its package does not ship the means to resolve: a bare import that is not in
 * `dependencies` or `peerDependencies` (a development dependency is installed here and nowhere else), and, in a
 * declaration file, a package whose types come from a `@types/*` development dependency (a consumer then has no types
 * for it: `import { Pool } from "pg"` is an implicit `any` under `strict`). `vp pack` leaves declared dependencies
 * external and bundles the rest, so an undeclared name here is a package that was left out of the manifest.
 */
export const importFindings = (
  manifest: Manifest,
  files: readonly BuiltFile[]
): readonly string[] => {
  const shipped = new Set([
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.peerDependencies),
  ]);

  return files.flatMap((file) =>
    importedPackages(file).flatMap((name) => {
      const where = `${manifest.name}: ${file.name} imports ${name}`;
      const types = typesPackage(name);

      if (!shipped.has(name)) {
        return [`${where}, which is not in dependencies or peerDependencies`];
      }

      return file.name.endsWith(".d.mts") &&
        types in manifest.devDependencies &&
        !shipped.has(types)
        ? [
            `${where}, and its types ${types} are a devDependency, which does not ship`,
          ]
        : [];
    })
  );
};
