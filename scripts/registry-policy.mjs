import { posix } from "node:path";

export const maturityNames = ["production-ready", "reference", "experimental"];

const allowedRoots = ["go/", "python/", "shared/sql/", "typescript/"];
const allowedExtensions = new Set([".go", ".js", ".py", ".sql", ".ts", ".tsx"]);

export function validateRegistryStructure(registry) {
  if (
    !registry ||
    typeof registry !== "object" ||
    Array.isArray(registry) ||
    registry.schemaVersion !== 1 ||
    !registry.maturity ||
    typeof registry.maturity !== "object" ||
    Array.isArray(registry.maturity)
  ) {
    throw new Error("components.json must use registry schema version 1");
  }

  const actualMaturityNames = Object.keys(registry.maturity).sort();
  if (actualMaturityNames.join("\n") !== [...maturityNames].sort().join("\n")) {
    throw new Error(`components.json must contain exactly these maturity buckets: ${maturityNames.join(", ")}`);
  }

  for (const maturity of maturityNames) {
    const paths = registry.maturity[maturity];
    if (!Array.isArray(paths)) throw new Error(`${maturity} must be an array`);
    for (const path of paths) {
      if (
        typeof path !== "string" ||
        !path ||
        path !== posix.normalize(path) ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").includes("..") ||
        !allowedRoots.some((prefix) => path.startsWith(prefix)) ||
        !allowedExtensions.has(posix.extname(path))
      ) {
        throw new Error(`components.json contains an unsafe or unsupported path: ${String(path)}`);
      }
    }
  }
}
