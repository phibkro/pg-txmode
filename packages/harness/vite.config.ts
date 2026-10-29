import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Each test file starts its own PostgreSQL and PgBouncer on free ports.
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
