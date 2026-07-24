const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calculateModelCostNanoUsd,
  executeWithCostGuard,
} = require("../.test-dist/infrastructure/ai-cost-guard.js");

const base = {
  tenantId: "tenant-1",
  actorId: "actor-1",
  endpoint: "summarise",
  operationId: "op-1",
  semanticRequestDigest: "a".repeat(64),
  maxRunNanoUsd: 10_000n,
  maximumUsage: { inputTokens: 1_000, outputTokens: 500 },
  rate: { inputNanoUsdPerToken: 2n, outputNanoUsdPerToken: 8n },
  decodeReplay: (stored) => {
    if (typeof stored !== "string") throw new Error("bad stored result");
    return stored;
  },
};
const reserved = (input, status = "reserved") => ({
  status,
  requestHash: input.requestHash,
  estimatedNanoUsd: input.estimatedNanoUsd,
});

test("uses exact fixed-point costs and atomically completes a replayable result", async () => {
  const calls = [];
  const store = {
    begin: async (input) => {
      calls.push(["begin", input]);
      return reserved(input);
    },
    complete: async (input) => calls.push(["complete", input]),
    quarantine: async () => assert.fail("must not quarantine success"),
  };
  const value = await executeWithCostGuard(store, {
    ...base,
    executeIdempotently: async (key) => {
      calls.push(["provider", key]);
      return { value: "done", usage: { inputTokens: 500, outputTokens: 100 } };
    },
  });
  assert.equal(value, "done");
  assert.equal(calls[0][1].estimatedNanoUsd, 6_000n);
  assert.equal(calls[2][1].actualNanoUsd, 1_800n);
  assert.match(calls[1][1], /^[a-f0-9]{64}$/);
});

test("replays completed results and rejects budget, conflict, and malformed store states", async () => {
  let executed = 0;
  let capturedHash;
  const input = { ...base, executeIdempotently: async () => { executed += 1; return { value: "x", usage: { inputTokens: 1, outputTokens: 1 } }; } };
  const captureStore = {
    begin: async ({ requestHash }) => { capturedHash = requestHash; return { status: "budget_exceeded" }; },
    complete: async () => {},
    quarantine: async () => {},
  };
  await assert.rejects(() => executeWithCostGuard(captureStore, input), /budget exceeded/);
  const replayStore = { ...captureStore, begin: async () => ({ status: "completed", requestHash: capturedHash, result: "saved" }) };
  assert.equal(await executeWithCostGuard(replayStore, input), "saved");
  assert.equal(executed, 0);
  for (const status of ["conflict", "nonsense"]) {
    await assert.rejects(
      () => executeWithCostGuard({ ...captureStore, begin: async () => ({ status }) }, input),
      /conflict|invalid reservation status/,
    );
  }
});

test("quarantines provider failures and invalid usage without booking zero spend", async () => {
  const quarantined = [];
  const store = {
    begin: async (input) => reserved(input),
    complete: async () => assert.fail("must not complete"),
    quarantine: async (input) => quarantined.push(input.reason),
  };
  await assert.rejects(
    () => executeWithCostGuard(store, { ...base, executeIdempotently: async () => { throw new Error("provider failed"); } }),
    /provider failed/,
  );
  await assert.rejects(
    () => executeWithCostGuard(store, {
      ...base,
      executeIdempotently: async () => ({ value: "x", usage: { inputTokens: 1.5, outputTokens: 0 } }),
    }),
    /safe integer/,
  );
  assert.deepEqual(quarantined, ["provider_failure", "invalid_usage"]);
});

test("preserves provider and usage errors when quarantine also fails", async () => {
  const store = {
    begin: async (input) => reserved(input),
    complete: async () => {},
    quarantine: async () => { throw new Error("quarantine failed"); },
  };
  const error = await executeWithCostGuard(store, {
    ...base,
    executeIdempotently: async () => { throw new Error("provider failed"); },
  }).catch((caught) => caught);
  assert.equal(error instanceof AggregateError, true);
  assert.deepEqual(error.errors.map(({ message }) => message), ["provider failed", "quarantine failed"]);
});

test("keeps the provider key stable when a completion retry resumes", async () => {
  const keys = [];
  let attempt = 0;
  const store = {
    begin: async (input) => reserved(input, attempt++ === 0 ? "reserved" : "resume"),
    complete: async () => {
      if (attempt === 1) throw new Error("ledger unavailable");
    },
    quarantine: async () => {},
  };
  const input = {
    ...base,
    executeIdempotently: async (key) => {
      keys.push(key);
      return { value: "same-provider-result", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  await assert.rejects(() => executeWithCostGuard(store, input), /ledger unavailable/);
  assert.equal(await executeWithCostGuard(store, input), "same-provider-result");
  assert.equal(keys[0], keys[1]);
});

test("enforces estimated and actual limits and validates reservation identity", async () => {
  const store = {
    begin: async (input) => reserved(input),
    complete: async () => assert.fail("overage must not complete"),
    quarantine: async (input) => {
      assert.equal(input.reason, "cost_overage");
      assert.equal(input.actualNanoUsd, 10_008n);
    },
  };
  await assert.rejects(
    () => executeWithCostGuard(store, {
      ...base,
      maxRunNanoUsd: 5_999n,
      executeIdempotently: async () => assert.fail("estimate must block execution"),
    }),
    /estimated AI cost/,
  );
  await assert.rejects(
    () => executeWithCostGuard(store, {
      ...base,
      maximumUsage: { inputTokens: 5_000, outputTokens: 0 },
      executeIdempotently: async () => ({
        value: "x",
        usage: { inputTokens: 5_000, outputTokens: 1 },
      }),
    }),
    /actual AI cost/,
  );
  await assert.rejects(
    () => executeWithCostGuard({
      ...store,
      begin: async (input) => ({ ...reserved(input), requestHash: "bad" }),
    }, { ...base, executeIdempotently: async () => assert.fail("must not execute") }),
    /conflicting reservation/,
  );
});

test("financial changes preserve provider identity while semantic changes rotate it", async () => {
  const keys = [];
  const store = {
    begin: async (input) => reserved(input),
    complete: async () => {},
    quarantine: async () => {},
  };
  for (const input of [
    base,
    { ...base, maxRunNanoUsd: 20_000n },
    { ...base, semanticRequestDigest: "b".repeat(64) },
  ]) {
    await executeWithCostGuard(store, {
      ...input,
      executeIdempotently: async (key) => {
        keys.push(key);
        return { value: "x", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
  }
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[1], keys[2]);
});

test("rejects unsafe numeric boundaries exactly", () => {
  assert.equal(
    calculateModelCostNanoUsd(
      { inputNanoUsdPerToken: 1_000_000_000_000n, outputNanoUsdPerToken: 0n },
      { inputTokens: 10_000_000_000, outputTokens: 0 },
    ),
    10_000_000_000_000_000_000_000n,
  );
  assert.throws(
    () => calculateModelCostNanoUsd(
      { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 1n },
      { inputTokens: 0.5, outputTokens: 0 },
    ),
    /safe integer/,
  );
  assert.throws(
    () => calculateModelCostNanoUsd(
      { inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1n },
      { inputTokens: 1, outputTokens: 1 },
    ),
    /bigint/,
  );
});

test("canonicalizes usage field order and enforces each reserved token category", async () => {
  const hashes = [];
  const quarantined = [];
  const store = {
    begin: async (input) => {
      hashes.push(input.requestHash);
      return reserved(input);
    },
    complete: async () => {},
    quarantine: async (input) => quarantined.push(input),
  };
  const execute = async (maximumUsage, usage = { inputTokens: 1, outputTokens: 1 }) =>
    executeWithCostGuard(store, {
      ...base,
      maximumUsage,
      executeIdempotently: async () => ({ value: "x", usage }),
    });
  await execute({ inputTokens: 1_000, outputTokens: 500 });
  await execute({ outputTokens: 500, inputTokens: 1_000 });
  assert.equal(hashes[0], hashes[1]);
  await assert.rejects(
    () => execute({ inputTokens: 1_000, outputTokens: 500 }, { inputTokens: 2_000, outputTokens: 0 }),
    /actual AI cost or usage/,
  );
  assert.equal(quarantined.at(-1).reason, "cost_overage");
  assert.equal(quarantined.at(-1).actualNanoUsd, 4_000n);
});

test("preserves overage and quarantine failures together", async () => {
  const store = {
    begin: async (input) => reserved(input),
    complete: async () => assert.fail("overage must not complete"),
    quarantine: async () => { throw new Error("quarantine failed"); },
  };
  const error = await executeWithCostGuard(store, {
    ...base,
    executeIdempotently: async () => ({
      value: "x",
      usage: { inputTokens: 2_000, outputTokens: 0 },
    }),
  }).catch((caught) => caught);
  assert.equal(error instanceof AggregateError, true);
  assert.deepEqual(
    error.errors.map(({ message }) => message),
    ["actual AI cost or usage exceeded the reserved maximum", "quarantine failed"],
  );
});
