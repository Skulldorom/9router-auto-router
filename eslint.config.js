const sharedGlobals = {
  console: "readonly",
  process: "readonly",
  Buffer: "readonly",
  Response: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  structuredClone: "readonly",
};

const rules = {
  "no-undef": "error",
  "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none" }],
  "no-unreachable": "error",
  "no-constant-binary-expression": "error",
  "no-async-promise-executor": "error",
  "no-shadow": "warn",
};

export default [
  {
    files: ["eslint.config.js", "patches/**/*.mjs", "scripts/**/*.mjs", "test/**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: sharedGlobals },
    rules,
  },
  {
    files: ["auto-router-config.cjs", "src/**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...sharedGlobals, require: "readonly", module: "readonly", exports: "writable", __dirname: "readonly", __filename: "readonly" },
    },
    rules,
  },
];
