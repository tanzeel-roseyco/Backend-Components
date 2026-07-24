const assert = require("node:assert/strict");
const test = require("node:test");
const { LeadSequenceEngine } = require("../.test-dist/business-logic/lead-sequence-engine.js");

function harness(overrides = {}) {
  const calls = { intake: [], sent: [], suppressed: [], failed: [], delivered: [] };
  const deliveryEffects = new Set();
  const store = {
    async intake(input) {
      calls.intake.push(input);
      return overrides.intakeResult ?? { leadId: "lead-1", created: true };
    },
    async claimDueSteps(_now, limit) {
      return overrides.overclaim ? overrides.steps : (overrides.steps ?? []).slice(0, limit);
    },
    async markSuppressed(id, reason) {
      calls.suppressed.push([id, reason]);
      if (overrides.markSuppressedError) throw new Error(overrides.markSuppressedError);
    },
    async markSent(id, at) {
      calls.sent.push([id, at]);
      if (overrides.markSentError) throw new Error(overrides.markSentError);
    },
    async markFailed(id, error, retryAt) { calls.failed.push([id, error, retryAt]); },
  };
  const engine = new LeadSequenceEngine({
    store,
    suppression: {
      async check(key) {
        return overrides.suppressedKey === key
          ? { suppressed: true, reason: overrides.suppressionReason ?? "unsubscribed" }
          : { suppressed: false };
      },
    },
    sender: {
      async sendIdempotently(message) {
        calls.delivered.push(message);
        if (overrides.sendError) throw new Error(overrides.sendError);
        deliveryEffects.add(message.deliveryKey);
      },
    },
    retryDelayMs: overrides.retryDelayMs ?? (() => 5_000),
  }, { maxAttempts: 3, maxBatchSize: 2 });
  return { engine, calls, deliveryEffects };
}

test("intake schedules delayed steps and a due step is sent", async () => {
  const { engine, calls } = harness({
    steps: [{
      id: "step-1", leadId: "lead-1", canonicalEmailKey: "person@example.com",
      idempotencyKey: "send-1", payload: { template: "welcome" }, attempts: 1,
    }],
  });
  const acceptedAt = new Date("2026-01-01T00:00:00Z");
  await engine.intake({
    canonicalEmailKey: "person@example.com",
    idempotencyKey: "intake-1",
    payload: { source: "form" },
    steps: [{ idempotencyKey: "send-1", delayMs: 60_000, payload: { template: "welcome" } }],
  }, acceptedAt);
  const result = await engine.processBatch(2, acceptedAt);

  assert.equal(calls.intake[0].steps[0].dueAt.toISOString(), "2026-01-01T00:01:00.000Z");
  assert.deepEqual(result, { claimed: 1, sent: 1, suppressed: 0, failed: 0 });
  assert.equal(calls.delivered[0].deliveryKey, "send-1");
});

test("suppressed leads are transitioned without sending", async () => {
  const step = {
    id: "step-2", leadId: "lead-2", canonicalEmailKey: "blocked@example.com",
    idempotencyKey: "send-2", payload: {}, attempts: 1,
  };
  const { engine, calls } = harness({ steps: [step], suppressedKey: step.canonicalEmailKey });
  const result = await engine.processBatch();

  assert.deepEqual(result, { claimed: 1, sent: 0, suppressed: 1, failed: 0 });
  assert.deepEqual(calls.suppressed, [["step-2", "unsubscribed"]]);
  assert.equal(calls.delivered.length, 0);

  const bounded = harness({
    steps: [step],
    suppressedKey: step.canonicalEmailKey,
    suppressionReason: "x".repeat(1_000),
  });
  await bounded.engine.processBatch();
  assert.equal(bounded.calls.suppressed[0][1].length, 500);
});

test("send failures retry until the attempt limit and preserve the idempotency key", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const step = {
    id: "step-3", leadId: "lead-3", canonicalEmailKey: "person@example.com",
    idempotencyKey: "stable-send-key", payload: {}, attempts: 2,
  };
  const retry = harness({ steps: [step], sendError: "provider down" });
  await retry.engine.processBatch(1, now);
  assert.equal(retry.calls.delivered[0].deliveryKey, "stable-send-key");
  assert.equal(retry.calls.failed[0][2].toISOString(), "2026-01-01T00:00:05.000Z");

  const exhausted = harness({ steps: [{ ...step, attempts: 3 }], sendError: "provider down" });
  await exhausted.engine.processBatch(1, now);
  assert.equal(exhausted.calls.failed[0][2], null);
});

test("duplicate intake is returned unchanged by the atomic store boundary", async () => {
  const { engine } = harness({ intakeResult: { leadId: "existing", created: false } });
  const result = await engine.intake({
    canonicalEmailKey: "person@example.com",
    idempotencyKey: "same-request",
    payload: {},
    steps: [],
  });
  assert.deepEqual(result, { leadId: "existing", created: false });
});

test("rejects overflowing dates, overlong keys, and malformed intake results", async () => {
  const input = {
    canonicalEmailKey: "person@example.com",
    idempotencyKey: "request",
    payload: {},
    steps: [{ idempotencyKey: "step", delayMs: 1, payload: {} }],
  };
  const { engine } = harness();
  await assert.rejects(
    () => engine.intake(input, new Date(8_640_000_000_000_000)),
    /dueAt/
  );
  await assert.rejects(
    () => engine.intake({ ...input, canonicalEmailKey: "x".repeat(321) }),
    /320/
  );
  await assert.rejects(
    () => engine.intake({ ...input, idempotencyKey: "x".repeat(201) }),
    /200/
  );
  await assert.rejects(
    () => engine.intake({ ...input, steps: [{ ...input.steps[0], idempotencyKey: "x".repeat(201) }] }),
    /200/
  );
  const malformed = harness({ intakeResult: { leadId: "", created: "yes" } });
  await assert.rejects(() => malformed.engine.intake({ ...input, steps: [] }), /created/);
});

test("rejects overclaims and malformed claimed steps before side effects", async () => {
  const valid = {
    id: "step", leadId: "lead", canonicalEmailKey: "person@example.com",
    idempotencyKey: "delivery", payload: {}, attempts: 1,
  };
  const overclaim = harness({ steps: [valid, valid], overclaim: true });
  await assert.rejects(() => overclaim.engine.processBatch(1), /more claimed/);
  assert.equal(overclaim.calls.delivered.length, 0);

  for (const invalid of [
    { ...valid, id: "" },
    { ...valid, attempts: 0 },
    { ...valid, attempts: 4 },
    { ...valid, idempotencyKey: "x".repeat(201) },
  ]) {
    const malformed = harness({ steps: [invalid] });
    await assert.rejects(() => malformed.engine.processBatch(1), /claimed|attempts|200/);
    assert.equal(malformed.calls.delivered.length, 0);
  }
});

test("transition failures propagate without recording a false send failure", async () => {
  const step = {
    id: "step", leadId: "lead", canonicalEmailKey: "person@example.com",
    idempotencyKey: "delivery", payload: {}, attempts: 1,
  };
  const { engine, calls } = harness({ steps: [step], markSentError: "database down" });
  await assert.rejects(() => engine.processBatch(1), /database down/);
  assert.equal(calls.delivered.length, 1);
  assert.equal(calls.failed.length, 0);

  const suppressed = harness({
    steps: [step],
    suppressedKey: step.canonicalEmailKey,
    markSuppressedError: "database down",
  });
  await assert.rejects(() => suppressed.engine.processBatch(1), /database down/);
  assert.equal(suppressed.calls.delivered.length, 0);
  assert.equal(suppressed.calls.failed.length, 0);
});

test("replay uses the same delivery key and retry fallback is bounded", async () => {
  const step = {
    id: "step", leadId: "lead", canonicalEmailKey: "person@example.com",
    idempotencyKey: "stable-delivery", payload: {}, attempts: 1,
  };
  const replay = harness({ steps: [step], markSentError: "database down" });
  await assert.rejects(() => replay.engine.processBatch(1));
  await assert.rejects(() => replay.engine.processBatch(1));
  assert.deepEqual(
    replay.calls.delivered.map((message) => message.deliveryKey),
    ["stable-delivery", "stable-delivery"]
  );
  assert.equal(replay.deliveryEffects.size, 1);

  const fallback = harness({
    steps: [step],
    sendError: "x".repeat(1_000),
    retryDelayMs: () => { throw new Error("bad policy"); },
  });
  const now = new Date("2026-01-01T00:00:00Z");
  await fallback.engine.processBatch(1, now);
  assert.equal(fallback.calls.failed[0][1].length, 500);
  assert.equal(fallback.calls.failed[0][2].toISOString(), "2026-01-01T00:01:00.000Z");

  const capped = harness({
    steps: [step],
    sendError: "provider down",
    retryDelayMs: () => Number.MAX_SAFE_INTEGER,
  });
  await capped.engine.processBatch(1, now);
  assert.equal(capped.calls.failed[0][2].toISOString(), "2026-01-02T00:00:00.000Z");
});

test("caps engine configuration and validates intake before reading steps", async () => {
  const dependencies = {
    store: {
      intake: async () => ({ leadId: "lead", created: true }),
      claimDueSteps: async () => [],
      markSuppressed: async () => {},
      markSent: async () => {},
      markFailed: async () => {},
    },
    suppression: { check: async () => ({ suppressed: false }) },
    sender: { sendIdempotently: async () => {} },
  };
  for (const options of [
    { maxBatchSize: 1_001 },
    { maxAttempts: 101 },
    { maxStepsPerLead: 1_001 },
  ]) {
    assert.throws(() => new LeadSequenceEngine(dependencies, options), /cannot exceed/);
  }
  const { engine } = harness();
  await assert.rejects(() => engine.intake(null), /input must be an object/);
  await assert.rejects(
    () => engine.intake({ canonicalEmailKey: "a", idempotencyKey: "b", steps: "not-array" }),
    /steps must be an array/,
  );
});

test("rejects duplicate claimed ids and delivery keys before side effects", async () => {
  const first = {
    id: "step-1", leadId: "lead", canonicalEmailKey: "person@example.com",
    idempotencyKey: "delivery-1", payload: {}, attempts: 1,
  };
  for (const second of [
    { ...first, idempotencyKey: "delivery-2" },
    { ...first, id: "step-2" },
  ]) {
    const setup = harness({ steps: [first, second] });
    await assert.rejects(() => setup.engine.processBatch(2), /duplicate claimed/);
    assert.equal(setup.calls.delivered.length, 0);
  }
});
