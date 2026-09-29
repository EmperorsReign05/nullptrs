import { defineConfig } from "vitest/config";
import path from "node:path";

// Vitest does not read tsconfig `paths`, so `@/...` (used by the app router and
// the dashboard components) did not resolve under test. That made route handlers
// untestable without standing up a dev server, which is exactly backwards: the
// /api/fleet adapter is where the Vercel fallback lives, so it is the module that
// most needs a test.
//
// The alias mirrors tsconfig.json's mapping and nothing else. No `include`,
// `environment` or other setting is changed, so every pre-existing test resolves
// and runs exactly as it did before this file existed.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
