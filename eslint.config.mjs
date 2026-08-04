import globals from "globals";
import pluginJs from "@eslint/js";

export default [
  // Build output, vendored code and the separately-linted docs site.
  {
    ignores: [
      "**/node_modules/**",
      "dist/**",
      "docs-site/**",
      "app/assets/**",
      "tests/cross-distro/app/**",
    ],
  },
  { files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
  { files: ["**/*.mjs"], languageOptions: { sourceType: "module" } },
  { files: ["testing/spikes/**/*.js"], languageOptions: { sourceType: "module" } },
  // Playwright configs and specs use ESM import syntax.
  {
    files: ["playwright*.config.js", "tests/e2e/**/*.js"],
    languageOptions: { sourceType: "module" },
  },
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  pluginJs.configs.recommended,
  {
    rules: {
      "no-var": "error",
      // `x == null` is an intentional null-or-undefined check used throughout
      // the codebase; every other comparison must be strict.
      eqeqeq: ["error", "always", { null: "ignore" }],

      // The `const { secret, ...rest } = obj` omit pattern is used to strip
      // sensitive fields before they cross an IPC boundary. The omitted binding
      // is intentionally unused.
      "no-unused-vars": [
        "error",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_" },
      ],

      // Correctness rules that catch real defects rather than style issues.
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      "require-atomic-updates": "error",

      // Security-relevant: these constructs execute strings as code.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-proto": "error",

      // An unhandled rejection terminates the main process.
      "prefer-promise-reject-errors": "error",
    },
  },
  {
    // Playwright's fixture signature `async ({}, testInfo)` requires an empty
    // destructuring pattern to reach the second argument. Declared last so it
    // wins over the recommended preset.
    files: ["tests/e2e/**/*.js"],
    rules: { "no-empty-pattern": "off" },
  },
];
