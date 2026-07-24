import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { maturityNames, validateRegistryStructure } from "./registry-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const registry = JSON.parse(readFileSync(join(root, "components.json"), "utf8"));
const allowedExtensions = new Set([".go", ".js", ".py", ".sql", ".ts", ".tsx"]);

validateRegistryStructure(registry);

const classified = maturityNames.flatMap((maturity) => registry.maturity[maturity]);
const unique = new Set(classified);
if (unique.size !== classified.length) {
  throw new Error("components.json classifies at least one component more than once");
}

for (const path of unique) {
  if (!existsSync(join(root, path))) throw new Error(`components.json references a missing component: ${path}`);
}

const implementations = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["dist", "node_modules", ".test-dist", "__pycache__", "tests"].includes(entry.name)) walk(path);
    } else if (
      allowedExtensions.has(extname(entry.name)) &&
      !entry.name.includes(".test.") &&
      !entry.name.endsWith("_test.go") &&
      entry.name !== "__init__.py" &&
      entry.name !== "index.ts"
    ) {
      implementations.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
}

for (const directory of ["typescript", "python", "go"]) walk(join(root, directory));
implementations.push("shared/sql/tenant-rls-reference.sql");

const missing = implementations.filter((path) => !unique.has(path));
const extra = [...unique].filter((path) => !implementations.includes(path));
if (missing.length || extra.length) {
  throw new Error(`component registry mismatch; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`);
}

const production = registry.maturity["production-ready"];
const productionTypeScript = production
  .filter((path) => path.startsWith("typescript/"))
  .map((path) => path.slice("typescript/".length))
  .sort();
const tsconfig = JSON.parse(readFileSync(join(root, "typescript/tsconfig.core.json"), "utf8"));
const compiledTypeScript = tsconfig.files.filter((path) => path !== "index.ts").sort();
if (productionTypeScript.join("\n") !== compiledTypeScript.join("\n")) {
  throw new Error("production-ready TypeScript components must exactly match tsconfig.core.json");
}

const lintedTypeScript = readFileSync(join(root, "typescript/core-files.txt"), "utf8")
  .split(/\r?\n/)
  .filter((path) => path && path !== "index.ts")
  .sort();
if (productionTypeScript.join("\n") !== lintedTypeScript.join("\n")) {
  throw new Error("production-ready TypeScript components must exactly match core-files.txt");
}

const indexModules = [...readFileSync(join(root, "typescript/index.ts"), "utf8").matchAll(/from "\.\/([^"]+)"/g)]
  .map((match) => `${match[1]}.ts`)
  .sort();
if (productionTypeScript.join("\n") !== indexModules.join("\n")) {
  throw new Error("production-ready TypeScript components must exactly match index.ts exports");
}

for (const path of production) {
  if (path.startsWith("typescript/")) {
    const test = path.replace(/\.(?:ts|tsx)$/, ".test.js");
    if (!existsSync(join(root, test))) throw new Error(`production component has no focused test: ${path}`);
  }
  if (path.endsWith(".go")) {
    const test = path.replace(/\.go$/, "_test.go");
    if (!existsSync(join(root, test))) throw new Error(`production component has no focused test: ${path}`);
  }
}

console.log(
  `Validated ${unique.size} components: ${production.length} production-ready, ` +
    `${registry.maturity.reference.length} reference, ${registry.maturity.experimental.length} experimental.`,
);
