{ pkgs, ... }:
{
  # Toolchain only. Vite+ needs Node >= 22.18 (root package.json engines).
  # gitleaks scans staged changes (pre-commit hook) and the full history (CI) for secrets; its
  # rules live in .gitleaks.toml. The git hooks and CI resolve every tool (vp, gitleaks,
  # commitlint) from this shell's PATH, so they run in the same pinned toolchain.
  #
  # postgresql_18 and pgbouncer are the servers of the harness (packages/harness). The tests start their own
  # throwaway instances on free ports; nothing needs `devenv up`. The PgBouncer settings are data in
  # packages/harness/src/profile.ts, never repeated here: `devenv up` runs the same code (`bun run stack`).
  packages = [
    pkgs.bun
    pkgs.nodejs_24
    pkgs.gitleaks
    pkgs.postgresql_18
    pkgs.pgbouncer
  ];

  processes.stack.exec = "bun run stack";
}
