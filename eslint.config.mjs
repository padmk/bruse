// Lint rules for the defect classes this project has met most: promises nobody awaits or catches,
// promises passed where a callback's result is ignored, and errors swallowed without a reason.
// Type-aware rules read the types from the tsconfig.json nearest to each file.

import tseslint from "typescript-eslint";

export default [
  { ignores: ["node_modules/", "dist/", "bench/results/"] },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // A promise nobody waits for is caught with .catch(ignore(reason)) or .catch(logFailure(what)).
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: false, allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it", "suite", "before", "after", "beforeEach", "afterEach"] }] },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      // An empty catch hides the error; a comment inside the block that gives the reason is enough.
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement'][body.body.length=0]",
          message: "Name why the rejection does not matter: .catch(ignore(\"reason\")) with ignore from browser/extension/shared.js.",
        },
        {
          selector: "CallExpression[callee.property.name='then'][arguments.length=2] > :matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement'][body.body.length=0]",
          message: "Name why the rejection does not matter: pass ignore(\"reason\") from browser/extension/shared.js.",
        },
        {
          selector: "CallExpression[callee.property.name=/^(on|once)$/][arguments.0.value='error'] > :matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement'][body.body.length=0]",
          message: "Name why the error does not matter: pass ignore(\"reason\") from browser/extension/shared.js.",
        },
      ],
      "max-lines": ["warn", { max: 800, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 200, skipBlankLines: true, skipComments: true }],
    },
  },
];
