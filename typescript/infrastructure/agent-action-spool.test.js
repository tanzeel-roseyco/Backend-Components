const assert = require("node:assert/strict");
const test = require("node:test");
const { AgentActionSpool } = require("../.test-dist/infrastructure/agent-action-spool.js");

function harness(overrides = {}) {
  const rows = new Map();
  const effects = new Map();
  const calls = { attempts: [], denied: [], failed: [], completed: [] };
  let nextId = 1;
  const find = (id) => [...rows.values()].find((row) => row.id === id);
  const store = {
    async enqueue(input) {
      const key = `${input.tenantId}\0${input.workspaceId}\0${input.idempotencyKey}`;
      const existing = rows.get(key);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          throw new Error("idempotency key reused with different action fingerprint");
        }
        return { id: existing.id, created: false };
      }
      const row = { ...input, id: `action-${nextId++}`, attempts: 0, state: "queued" };
      rows.set(key, row);
      return { id: row.id, created: true };
    },
    async claim({ limit }) {
      const due = [...rows.values()].filter((row) => row.state === "queued").slice(0, limit);
      return due.map((row) => {
        row.state = "claimed";
        row.attempts += 1;
        row.leaseToken = `lease-${row.attempts}`;
        return {
          ...row,
          fingerprint: overrides.tamperClaimFingerprint ?? row.fingerprint,
          ...(overrides.tamperClaim ?? {}),
        };
      });
    },
    async complete(id, leaseToken) {
      if (overrides.loseCompletionFor === id) return false;
      const row = find(id);
      if (!row || row.leaseToken !== leaseToken) return false;
      row.state = "completed";
      calls.completed.push(id);
      return true;
    },
    async deny(id, leaseToken, reason) {
      const row = find(id);
      if (!row || row.leaseToken !== leaseToken) return false;
      row.state = "denied";
      calls.denied.push([id, reason]);
      return true;
    },
    async fail(id, leaseToken, error, retryAt) {
      const row = find(id);
      if (!row || row.leaseToken !== leaseToken) return false;
      row.state = retryAt ? "queued" : "failed";
      calls.failed.push([id, error, retryAt]);
      return true;
    },
  };
  const spool = new AgentActionSpool({
    store,
    workspaceResolver: {
      resolve: async (tenantId, workspaceId) => overrides.missingWorkspace
        ? null
        : {
            tenantId: overrides.resolvedTenantId ?? tenantId,
            id: workspaceId,
            executionScope: `${tenantId}/${workspaceId}`,
          },
    },
    policy: {
      authorize: async (input, workspace) =>
        overrides.policyDecision?.(input, workspace) ?? { allowed: true },
    },
    executor: {
      execute: async (input, workspace) => {
        calls.attempts.push([input.idempotencyKey, workspace.executionScope]);
        if (overrides.executionError) throw new Error(overrides.executionError);
        const key = `${input.tenantId}\0${input.workspaceId}\0${input.idempotencyKey}`;
        if (!effects.has(key)) effects.set(key, structuredClone(input.payload));
      },
    },
    retryDelayMs: overrides.retryDelayMs ?? (() => 5_000),
  }, { maxAttempts: overrides.maxAttempts ?? 3, maxBatchSize: 10, leaseMs: 30_000 });
  return { spool, calls, effects, rows };
}

const action = {
  tenantId: "tenant-1",
  workspaceId: "workspace-1",
  idempotencyKey: "request-1",
  verb: "reply",
  target: "thread:1",
  payload: { text: "hello", nested: { b: 2, a: 1 } },
};

test("enqueues an immutable canonical snapshot and completes an allowed action", async () => {
  const { spool, calls, effects, rows } = harness();
  const mutable = structuredClone(action);
  assert.deepEqual(await spool.enqueue(mutable), { id: "action-1", created: true });
  mutable.payload.text = "changed";
  mutable.payload.nested.a = 99;
  const stored = [...rows.values()][0];
  assert.equal(stored.payload.text, "hello");
  assert.equal(Object.isFrozen(stored.payload), true);
  assert.deepEqual(await spool.processBatch("worker-1", 1, new Date("2026-01-01T00:00:00Z")), {
    claimed: 1, executed: 1, completed: 1, denied: 0, failed: 0, transitionLost: 0,
  });
  assert.equal(effects.size, 1);
  assert.deepEqual(calls.completed, ["action-1"]);
});

test("idempotency replay requires the same canonical action fingerprint", async () => {
  const { spool } = harness();
  const first = await spool.enqueue(action);
  const reordered = { ...action, payload: { nested: { a: 1, b: 2 }, text: "hello" } };
  assert.deepEqual(await spool.enqueue(reordered), { id: first.id, created: false });
  await assert.rejects(
    () => spool.enqueue({ ...action, target: "thread:other" }),
    /different action fingerprint/
  );
});

test("dangerous JSON keys remain own fingerprinted data without prototype inheritance", async () => {
  const dangerous = JSON.parse('{"__proto__":{"admin":true},"constructor":{"name":"attacker"}}');
  const conflict = harness();
  await conflict.spool.enqueue({ ...action, payload: {} });
  await assert.rejects(
    () => conflict.spool.enqueue({ ...action, payload: dangerous }),
    /different action fingerprint/,
  );

  let observedPayload;
  const setup = harness({
    policyDecision: (input) => {
      observedPayload = input.payload;
      return { allowed: true };
    },
  });
  await setup.spool.enqueue({
    ...action,
    idempotencyKey: "dangerous-keys",
    payload: dangerous,
  });
  await setup.spool.processBatch("worker-1", 1);
  assert.equal(Object.getPrototypeOf(observedPayload), null);
  assert.equal(Object.hasOwn(observedPayload, "__proto__"), true);
  assert.equal(Object.hasOwn(observedPayload, "constructor"), true);
  assert.equal(observedPayload.admin, undefined);
  assert.equal(observedPayload.__proto__.admin, true);
});

test("sparse arrays cannot replay or pass claimed-action fingerprint checks as nulls", async () => {
  const sparse = Array(1);
  const replay = harness();
  await replay.spool.enqueue({ ...action, payload: [null] });
  await assert.rejects(
    () => replay.spool.enqueue({ ...action, payload: sparse }),
    /sparse holes/
  );

  const claimed = harness({ tamperClaim: { payload: sparse } });
  await claimed.spool.enqueue({ ...action, payload: [null] });
  await assert.rejects(
    () => claimed.spool.processBatch("worker-1", 1),
    /sparse holes/
  );
  assert.equal(claimed.calls.attempts.length, 0);
});

test("rejects a tampered claimed action before policy or execution", async () => {
  let policyCalls = 0;
  const setup = harness({
    tamperClaim: { target: "thread:attacker" },
    policyDecision: () => {
      policyCalls++;
      return { allowed: true };
    },
  });
  await setup.spool.enqueue(action);
  await assert.rejects(
    () => setup.spool.processBatch("worker-1", 1),
    /fingerprint does not match/
  );
  assert.equal(policyCalls, 0);
  assert.equal(setup.calls.attempts.length, 0);
});

test("policy cannot mutate the frozen action or workspace observed by executor", async () => {
  const setup = harness({
    policyDecision: (input, workspace) => {
      input.target = "thread:attacker";
      input.payload.text = "changed";
      workspace.executionScope = "tenant-2/workspace-2";
      return { allowed: true };
    },
  });
  await setup.spool.enqueue(action);
  await setup.spool.processBatch("worker-1", 1);
  assert.deepEqual(setup.calls.attempts, [["request-1", "tenant-1/workspace-1"]]);
  assert.deepEqual([...setup.effects.values()], [action.payload]);
});

test("workspace tenant mismatch and malformed policy denials fail closed", async () => {
  const wrongTenant = harness({ resolvedTenantId: "tenant-2" });
  await assert.rejects(() => wrongTenant.spool.enqueue(action), /not approved/);

  const denied = harness({
    policyDecision: (input) => input.idempotencyKey === "bad"
      ? { allowed: false, reason: "x".repeat(1_000) }
      : { allowed: true },
  });
  await denied.spool.enqueue({ ...action, idempotencyKey: "bad" });
  await denied.spool.enqueue({ ...action, idempotencyKey: "good" });
  const result = await denied.spool.processBatch("worker-1", 2);
  assert.deepEqual(result, {
    claimed: 2, executed: 1, completed: 1, denied: 1, failed: 0, transitionLost: 0,
  });
  assert.deepEqual(denied.calls.denied, [["action-1", "denied by action policy"]]);
});

test("atomic claims isolate racing workers", async () => {
  const { spool, effects, calls } = harness();
  await spool.enqueue(action);
  await Promise.all([spool.processBatch("worker-a"), spool.processBatch("worker-b")]);
  assert.equal(effects.size, 1);
  assert.equal(calls.attempts.length, 1);
});

test("completion loss is recorded, batch continues, and executor replay is idempotent", async () => {
  const controls = { loseCompletionFor: "action-1" };
  const { spool, effects, calls, rows } = harness(controls);
  await spool.enqueue(action);
  await spool.enqueue({ ...action, idempotencyKey: "request-2" });
  const first = await spool.processBatch("worker-1", 2);
  assert.deepEqual(first, {
    claimed: 2, executed: 2, completed: 1, denied: 0, failed: 0, transitionLost: 1,
  });
  assert.equal(effects.size, 2);

  controls.loseCompletionFor = undefined;
  const crashed = [...rows.values()].find((row) => row.id === "action-1");
  crashed.state = "queued";
  await spool.processBatch("worker-2", 1);
  assert.equal(calls.attempts.filter(([key]) => key === "request-1").length, 2);
  assert.equal(effects.size, 2);
});

test("execution failures use a safe retry fallback and exhaust cleanly", async () => {
  const retrying = harness({
    executionError: "provider down",
    maxAttempts: 2,
    retryDelayMs: () => { throw new Error("bad retry config"); },
  });
  await retrying.spool.enqueue(action);
  const now = new Date("2026-01-01T00:00:00Z");
  await retrying.spool.processBatch("worker-1", 1, now);
  assert.equal(retrying.calls.failed[0][2].toISOString(), "2026-01-01T00:01:00.000Z");
  await retrying.spool.processBatch("worker-1", 1, now);
  assert.equal(retrying.calls.failed[1][2], null);
});

test("rejects non-JSON and oversized payloads before durable storage", async () => {
  const { spool, rows } = harness();
  await assert.rejects(() => spool.enqueue({ ...action, payload: { value: undefined } }), /JSON values/);
  await assert.rejects(
    () => spool.enqueue({ ...action, payload: { text: "x".repeat(70_000) } }),
    /payload/
  );
  assert.equal(rows.size, 0);
});
