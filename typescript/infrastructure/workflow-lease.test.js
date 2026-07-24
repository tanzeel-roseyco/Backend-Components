const assert = require("node:assert/strict");
const test = require("node:test");
const { InMemoryWorkflowLeaseStore } = require("../.test-dist/infrastructure/workflow-lease.js");

test("only one owner can hold an unexpired lease", async () => {
  const store = new InMemoryWorkflowLeaseStore(() => new Date(0));
  assert.ok(await store.acquire("job", "one", 1000));
  assert.equal(await store.acquire("job", "two", 1000), null);
});

test("a stale lease cannot release a later acquisition by the same owner", async () => {
  let time = 0;
  let sequence = 0;
  const store = new InMemoryWorkflowLeaseStore(() => new Date(time), 60 * 60 * 1000, () => `lease-${++sequence}`);
  const first = await store.acquire("job", "one", 10);
  time = 11;
  const second = await store.acquire("job", "one", 10);
  assert.ok(first && second);
  assert.notEqual(first.fencingToken, second.fencingToken);
  assert.equal(await store.release(first), false);
  assert.equal(await store.release(second), true);
});

test("renewal is token-bound and invalid durations fail", async () => {
  let time = 0;
  const store = new InMemoryWorkflowLeaseStore(() => new Date(time), 100);
  const lease = await store.acquire("job", "one", 10);
  assert.ok(lease);
  const renewed = await store.renew(lease, 100);
  assert.equal(renewed.expiresAt.getTime(), 100);
  time = 101;
  assert.equal(await store.renew(renewed, 10), null);
  await assert.rejects(() => store.acquire("other", "one", Number.MAX_VALUE));
  await assert.rejects(() => store.acquire("other", "one", 0.1));
});

test("invalid inputs and fencing-token exhaustion fail deliberately", async () => {
  assert.throws(() => new InMemoryWorkflowLeaseStore(() => new Date(), 0.1));
  const invalidClockStore = new InMemoryWorkflowLeaseStore(() => new Date(Number.NaN));
  await assert.rejects(() => invalidClockStore.acquire("job", "one", 10));
  const dateOverflowStore = new InMemoryWorkflowLeaseStore(() => new Date(8.64e15), 100);
  await assert.rejects(() => dateOverflowStore.acquire("job", "one", 1));

  const store = new InMemoryWorkflowLeaseStore(() => new Date(0));
  store.fencingTokens.set("job", Number.MAX_SAFE_INTEGER);
  await assert.rejects(() => store.acquire("job", "one", 10));
  await assert.rejects(() => store.acquire(null, "one", 10));
});

test("returned snapshots cannot mutate or forge store authority", async () => {
  let time = 0;
  const store = new InMemoryWorkflowLeaseStore(() => new Date(time), 100, () => "opaque-id");
  const lease = await store.acquire("job", "one", 10);
  lease.expiresAt.setTime(1000);
  time = 11;
  const replacement = await store.acquire("job", "two", 10);
  assert.ok(replacement);

  const forged = { ...replacement, owner: "attacker" };
  assert.equal(await store.release(forged), false);
  assert.equal(await store.renew(forged, 10), null);
  assert.equal(await store.release(replacement), true);
});
