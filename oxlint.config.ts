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
  },
  overrides: [
    {
      // Vendored from deanjstone/design-system via the shadcn CLI: upstream's shape, not ours,
      // and a local edit is lost on the next `shadcn add`. shadcn components export their cva
      // variants alongside the component (`buttonVariants`), which only-export-components rejects.
      files: ["src/components/ui/**/*.{ts,tsx}"],
      rules: { "react/only-export-components": "off" },
    },
    {
      files: ["**/*.test.{ts,tsx}", "**/test/**"],
      rules: { "anti-slop/no-module-mocking": "warn" },
    },
  ],
});
