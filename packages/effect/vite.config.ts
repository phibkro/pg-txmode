import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
