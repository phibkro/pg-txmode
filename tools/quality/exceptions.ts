// Provenance: ported from reebeat/studio @ d4fd75eaca83b9e8a98f073d5b1d957da5d6b8b8 (tools/quality/effectExceptions.ts),
// which split it from phibkro/vektorprogrammet-reimagined @ 797e9e41d96194b9479ff224ac1c40bbc0545888
// (tools/quality/checkEffectExceptions.ts). Deviation: plain TypeScript with node:fs and zod instead of Effect and its
// Schema (pg-txmode's core does not depend on Effect, and a tool follows the same rule). See PROVENANCE.md.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { z } from "zod";

const text = z.string().min(1);

const ExceptionEntrySchema = z.object({
  id: text,
  nativeAlternativesExamined: z.array(text).min(1),
  owner: text,
  reason: text,
  retirementTrigger: text,
  scope: z.object({
    directives: z.array(text).min(1),
    files: z.array(text).min(1),
  }),
  versions: z.record(text, text),
});

const Registry = z.object({
  description: text,
  exceptions: z.array(ExceptionEntrySchema),
});

export type ExceptionEntry = z.infer<typeof ExceptionEntrySchema>;

export interface ExceptionCheckInput {
  /** Repository-relative paths that git tracks or would track. Files missing on disk are skipped. */
  readonly paths: readonly string[];
  /** Absolute path of the registry JSON. */
  readonly registryPath: string;
  /** Absolute directory that `paths` are relative to. */
  readonly root: string;
}

export interface ExceptionCheckResult {
  readonly exceptionCount: number;
  /** One sentence per violation, each naming the file and line or the registry entry. Empty when clean. */
  readonly findings: readonly string[];
}

const directivePattern =
  /(?:oxlint-disable(?:-next-line|-line)?|eslint-disable(?:-next-line|-line)?|@ts-expect-error|@ts-ignore|@ts-nocheck)/gu;

const sourcePattern = /\.[cm]?[jt]sx?$/u;

const ignoredPrefixes = ["node_modules/", ".devenv/", ".worktrees/"];

interface Site {
  readonly directive: string;
  readonly line: number;
  readonly path: string;
}

const isScannable = (file: string): boolean =>
  sourcePattern.test(file) &&
  !file.includes("/node_modules/") &&
  !ignoredPrefixes.some((prefix) => file.startsWith(prefix));

const sitesIn = (root: string, file: string): readonly Site[] => {
  const source = readFileSync(path.join(root, file), "utf-8");

  return parseSync(file, source).comments.flatMap((comment) => {
    const line = source.slice(0, comment.start).split("\n").length;

    return [...comment.value.matchAll(directivePattern)].map(
      ([directive]): Site => ({ directive, line, path: file })
    );
  });
};

/**
 * Every suppression directive in the scanned sources needs a registry entry for that file and directive, and every
 * registry entry needs a live suppression and an existing file.
 */
export const checkExceptions = (
  input: ExceptionCheckInput
): ExceptionCheckResult => {
  // `git ls-files -c` also lists tracked files deleted from the working tree (for example mid-rename).
  const present = input.paths.filter((file) =>
    existsSync(path.join(input.root, file))
  );

  const { exceptions } = Registry.parse(
    JSON.parse(readFileSync(input.registryPath, "utf-8"))
  );

  const sites = present
    .filter(isScannable)
    .flatMap((file) => sitesIn(input.root, file));

  const classified = sites.map((site) => ({
    exception: exceptions.find(
      (entry) =>
        entry.scope.files.includes(site.path) &&
        entry.scope.directives.includes(site.directive)
    ),
    site,
  }));

  const unregistered = classified.flatMap(({ exception, site }) =>
    exception === undefined
      ? [`${site.path}:${site.line}: unregistered ${site.directive}`]
      : []
  );

  const liveIds = new Set(
    classified.flatMap(({ exception }) =>
      exception === undefined ? [] : [exception.id]
    )
  );

  const stale = exceptions.flatMap((exception) => [
    ...(present.some((file) => exception.scope.files.includes(file))
      ? []
      : [`${exception.id} lists no existing source file`]),
    ...(liveIds.has(exception.id)
      ? []
      : [`${exception.id} has no live suppression site`]),
  ]);

  const duplicates = exceptions.flatMap((exception, index) =>
    exceptions.slice(0, index).some((other) => other.id === exception.id)
      ? [`duplicate id ${exception.id}`]
      : []
  );

  return {
    exceptionCount: exceptions.length,
    findings: [...unregistered, ...stale, ...duplicates],
  };
};
