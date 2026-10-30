// `bun run release:stage`: builds what is published, into `packages/<name>/dist`, and checks that nothing else ships
// (spec 0006). For each published package: `vp pack` of its exports and bin with declarations, the manifest that ships
// (`releaseManifest`), the repository's LICENSE and NOTICE, a README, and the CHANGELOG when Changesets wrote one. Then
// `npm pack --dry-run --json` of a copy outside the repository (npm refuses to run below a root `package.json` whose
// `devEngines.packageManager` names another tool) and a failure on any file that is not built output, and on any
// import of a built file that the manifest does not ship the means to resolve (`importFindings`).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  globSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtFile,
  entryPoints,
  importFindings,
  ManifestSchema,
  PackListingSchema,
  publishedPackages,
  releaseManifest,
  RootSchema,
  strayFiles,
} from "./release.ts";
import type { BuiltFile, PackageEntry, ShippedManifest } from "./release.ts";

const root = path.resolve(import.meta.dirname, "../..");
const homepage = "https://github.com/phibkro/pg-txmode#readme";

const readText = (file: string): string => readFileSync(file, "utf-8");

const workspacePackages = (): readonly PackageEntry[] =>
  globSync("packages/*/package.json", { cwd: root })
    .toSorted()
    .map((file) => ({
      dir: path.dirname(file),
      manifest: ManifestSchema.parse(
        JSON.parse(readText(path.join(root, file)))
      ),
    }));

const run = (command: string, args: readonly string[], cwd: string): string =>
  execFileSync(command, [...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });

/** The bin file runs under Node: `vp pack` keeps the source's shebang (bun), so the first line is set here. */
const nodeShebang = (file: string): void => {
  const lines = readText(file).split("\n");
  const body = lines[0]?.startsWith("#!") === true ? lines.slice(1) : lines;

  writeFileSync(file, ["#!/usr/bin/env node", ...body].join("\n"));
  chmodSync(file, 0o755);
};

const stage = (entry: PackageEntry, manifest: ShippedManifest): void => {
  const dir = path.join(root, entry.dir);
  const dist = path.join(dir, "dist");

  rmSync(dist, { force: true, recursive: true });
  run(
    "bunx",
    [
      "vp",
      "pack",
      ...entryPoints(entry.manifest),
      "--dts",
      "--out-dir",
      "dist",
    ],
    dir
  );
  writeFileSync(
    path.join(dist, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  copyFileSync(path.join(root, "LICENSE"), path.join(dist, "LICENSE"));
  copyFileSync(path.join(root, "NOTICE"), path.join(dist, "NOTICE"));

  // A package's own README ships when it has one; the others get a short generated one.
  if (existsSync(path.join(dir, "README.md"))) {
    copyFileSync(path.join(dir, "README.md"), path.join(dist, "README.md"));
  } else {
    writeFileSync(
      path.join(dist, "README.md"),
      `# ${entry.manifest.name}\n\n${entry.manifest.description}\n\nDocumentation, the catalogue and the rules: ${homepage}\n`
    );
  }

  if (existsSync(path.join(dir, "CHANGELOG.md"))) {
    copyFileSync(
      path.join(dir, "CHANGELOG.md"),
      path.join(dist, "CHANGELOG.md")
    );
  }

  for (const source of Object.values(entry.manifest.bin ?? {})) {
    nodeShebang(path.join(dist, builtFile(source)));
  }
};

/** The files `npm pack` would put in the tarball of `dist`, taken from a copy outside the repository. */
const tarballFiles = (dist: string): readonly string[] => {
  const scratch = mkdtempSync(path.join(tmpdir(), "pg-txmode-pack-"));

  try {
    cpSync(dist, scratch, { recursive: true });

    return strayFiles(
      PackListingSchema.parse(
        JSON.parse(run("npm", ["pack", "--dry-run", "--json"], scratch))
      )
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
};

const rootManifest = RootSchema.parse(
  JSON.parse(readText(path.join(root, "package.json")))
);

const published = publishedPackages(workspacePackages());

const context = {
  catalog: rootManifest.catalog,
  versions: new Map(
    published.map((entry) => [entry.manifest.name, entry.manifest.version])
  ),
};

const staged = published.map((entry) => ({
  entry,
  result: releaseManifest(entry, rootManifest, context),
}));

const problems = staged.flatMap(({ result }) =>
  result.ok ? [] : result.problems
);

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}

for (const { entry, result } of staged) {
  if (result.ok) {
    stage(entry, result.manifest);
  }
}

const builtFiles = (dist: string): readonly BuiltFile[] =>
  readdirSync(dist)
    .filter((name) => name.endsWith(".mjs") || name.endsWith(".d.mts"))
    .map((name) => ({ name, text: readText(path.join(dist, name)) }));

/** The sources the bundler reads: an import of a development dependency there is inlined, so no built file shows it. */
const sourceFiles = (dir: string): readonly BuiltFile[] =>
  globSync("src/**/*.ts", { cwd: dir }).map((name) => ({
    name,
    text: readText(path.join(dir, name)),
  }));

const findings = staged.flatMap(({ entry }) => [
  ...tarballFiles(path.join(root, entry.dir, "dist")).map(
    (file) =>
      `${entry.manifest.name}: ${file} would ship and is not built output`
  ),
  ...importFindings(entry.manifest, [
    ...builtFiles(path.join(root, entry.dir, "dist")),
    ...sourceFiles(path.join(root, entry.dir)),
  ]),
]);

if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Staged ${published.map((entry) => entry.manifest.name).join(", ")}.\n`
);
