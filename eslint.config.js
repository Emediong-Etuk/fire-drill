import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "vendor-ref/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // Safety: model output is never executed on the user's machine.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "child_process", message: "Fire Drill never shells out." },
            { name: "node:child_process", message: "Fire Drill never shells out." },
            { name: "vm", message: "Fire Drill never evaluates code." },
            { name: "node:vm", message: "Fire Drill never evaluates code." },
            { name: "worker_threads", message: "Fire Drill never evaluates code." },
            { name: "node:worker_threads", message: "Fire Drill never evaluates code." },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
  },
);
