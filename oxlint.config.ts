import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "react"],
  env: { browser: true },
  ignorePatterns: ["dist/**", "**/node_modules/**", "tools/oxlint/anti-slop/**"],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: {
    "react/rules-of-hooks": "error",
    "react/exhaustive-deps": "error",
    "react/only-export-components": ["warn", { allowConstantExport: true }],
    "typescript/no-floating-promises": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-object-parameters": "warn",
  },
  overrides: [
    {
      // Vendored from deanjstone-hl/frontend via the shadcn CLI: upstream's shape, not ours,
      // and a local edit is lost on the next `shadcn add`. shadcn components export their cva
      // variants alongside the component (`buttonVariants`), which only-export-components rejects.
      files: ["src/components/ui/**/*.{ts,tsx}"],
      rules: { "react/only-export-components": "off" },
    },
    {
      // Vendored from the frontend links registry (ADR-0004): upstream's shape, and a local edit
      // is lost on the next `shadcn add`.
      files: ["src/lib/links-core.ts", "src/lib/links.ts"],
      rules: { "anti-slop/no-conditional-empty-object-spread": "off" },
    },
    {
      files: ["**/*.test.{ts,tsx}", "**/test/**"],
      rules: { "anti-slop/no-module-mocking": "warn" },
    },
  ],
});
