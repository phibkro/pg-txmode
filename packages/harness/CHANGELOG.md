# @pg-txmode/harness

## 0.1.0-alpha.1

### Minor Changes

- The harness is published: a test tool that starts a throwaway PostgreSQL and a PgBouncer from PATH, runs the probe matrix against the catalogue, and records statements. Servers it starts are killed and their directories removed if the starting process dies before stop().

### Patch Changes

- @pg-txmode/core@0.1.0-alpha.1
