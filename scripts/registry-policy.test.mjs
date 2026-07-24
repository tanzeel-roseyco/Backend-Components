import assert from "node:assert/strict";
import test from "node:test";
import { validateRegistryStructure } from "./registry-policy.mjs";

function registry(path = "typescript/utilities/example.ts") {
  return {
    schemaVersion: 1,
    maturity: {
      "production-ready": [path],
      reference: [],
      experimental: [],
    },
  };
}

test("accepts a normalized component path", () => {
  assert.doesNotThrow(() => validateRegistryStructure(registry()));
});

for (const path of [
  "../secret.ts",
  "/absolute.ts",
  "typescript\\example.ts",
  "unknown/example.ts",
  "typescript/example.exe",
  "",
]) {
  test(`rejects unsafe registry path ${JSON.stringify(path)}`, () => {
    assert.throws(() => validateRegistryStructure(registry(path)));
  });
}

test("rejects unknown maturity buckets and schema versions", () => {
  const unknownBucket = registry();
  unknownBucket.maturity.deprecated = [];
  assert.throws(() => validateRegistryStructure(unknownBucket));

  const unknownVersion = registry();
  unknownVersion.schemaVersion = 2;
  assert.throws(() => validateRegistryStructure(unknownVersion));
});
