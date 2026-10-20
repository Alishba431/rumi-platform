import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Component tests for the portal (`npm test`). Mirrors the vite `@` alias.
// The pure logic in src/lib/*.cjs is tested from the repo root's Jest suite
// (tests/portal/); these cover the React components that wire it up.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
  },
});
