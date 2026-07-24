const assert = require("node:assert/strict");
const test = require("node:test");
const { AbandonedCartRecovery } = require("../.test-dist/business-logic/abandoned-cart-recovery.js");

function harness(options = {}) {
  let now = Date.parse("2026-01-02T00:00:00Z");
  const row = {
    tenantId: "tenant-1", cartId: "cart-1", sequence: 1, attempts: 0,
    status: "eligible", fence: 0, leaseToken: "", leaseUntil: 0,
    lastActivityAt: new Date("2026-01-01T20:00:00Z"),
    checkoutUrl: "https://shop.example/checkout/cart-1",
    customerEmail: options.email ?? " Buyer@Example.COM ",
    currency: options.currency ?? " aud ",
    lines: options.lines ?? [{ productId: "p1", name: "Product", quantity: 2, unitPriceMinor: 2500 }],
  };
  const calls = { sends: 0, sideEffects: new Set(), sent: 0, failed: [], suppressed: [] };
  const owns = (lease) =>
    row.status === "claimed" && lease.tenantId === row.tenantId &&
    lease.cartId === row.cartId && lease.sequence === row.sequence &&
    lease.leaseToken === row.leaseToken && lease.fence === row.fence;
  const store = {
    async listEligible() { return [{ cartId: row.cartId, sequence: row.sequence }]; },
    async claim(input) {
      if (input.tenantId !== row.tenantId || row.status === "sent" || row.status === "suppressed") return null;
      if (row.status === "claimed" && row.leaseUntil > input.now.getTime()) return null;
      if (row.attempts >= input.maxAttempts) return null;
      row.status = "claimed";
      row.attempts++;
      row.fence++;
      row.leaseToken = `lease-${row.fence}`;
      row.leaseUntil = input.now.getTime() + input.leaseMs;
      return { ...row, ...(options.claimPatch ?? {}) };
    },
    async renew(lease, current, leaseMs) {
      if (!owns(lease)) return null;
      row.leaseUntil = current.getTime() + leaseMs;
      return new Date(row.leaseUntil);
    },
    async authorizeDispatch(input) {
      if (!owns(input.lease)) throw new Error("stale dispatch");
      if (!options.consent || options.suppressed) {
        return { status: "suppressed", reason: options.suppressed ? "unsubscribed" : "marketing consent absent" };
      }
      if (row.outbox) {
        if (row.outbox.requestHash !== input.requestHash) {
          return { status: "conflict", requestHash: row.outbox.requestHash };
        }
        return { status: "authorized", outcome: "replay", ...row.outbox };
      }
      row.outbox = Object.freeze({
        requestHash: input.requestHash,
        deliveryKey: input.deliveryKey,
        message: input.message,
      });
      return { status: "authorized", outcome: "created", ...row.outbox };
    },
    async markSent(lease) {
      if (options.sentTransitionError) throw new Error(options.sentTransitionError);
      if (!owns(lease)) return false;
      row.status = "sent";
      calls.sent++;
      return true;
    },
    async markSuppressed(lease, reason) {
      if (!owns(lease)) return false;
      row.status = "suppressed";
      calls.suppressed.push(reason);
      return true;
    },
    async markFailed(lease, error, retryAt) {
      if (options.failTransitionError) throw new Error(options.failTransitionError);
      if (!owns(lease)) return false;
      row.status = retryAt ? "eligible" : "failed";
      calls.failed.push([error, retryAt]);
      return true;
    },
  };
  const sender = {
    async sendIdempotently(input) {
      calls.sends++;
      if (options.sendGate) await options.sendGate;
      if (options.hangSender) return new Promise(() => {});
      if (options.senderError) throw new Error(options.senderError);
      calls.sideEffects.add(input.deliveryKey);
    },
  };
  const recovery = new AbandonedCartRecovery(store, sender, {
    inactivityMs: 60 * 60_000,
    leaseMs: 1_000,
    operationTimeoutMs: options.operationTimeoutMs ?? 50,
    maxAttempts: 2,
    maxBatchSize: 2,
    now: () => now,
  });
  return { recovery, row, calls, store, advance: (ms) => { now += ms; } };
}

test("atomically authorizes and sends one immutable canonical message", async () => {
  const setup = harness({ consent: true });
  const result = await setup.recovery.processBatch("tenant-1", 1);
  assert.equal(result.sent, 1);
  assert.equal(setup.row.outbox.message.email, "buyer@example.com");
  assert.equal(setup.row.outbox.message.currency, "AUD");
  assert.equal(setup.row.outbox.message.totalMinor, 5000);
  assert.equal(Object.isFrozen(setup.row.outbox.message.lines), true);
  assert.match(setup.row.outbox.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(setup.calls.sideEffects.size, 1);
});

test("same sequence rejects a changed payload or currency without replacing the outbox", async () => {
  const controls = { consent: true, sentTransitionError: "database down" };
  const setup = harness(controls);
  await assert.rejects(() => setup.recovery.processBatch("tenant-1", 1), /database down/);
  const originalOutbox = setup.row.outbox;
  setup.row.currency = "USD";
  setup.row.lines = [{ productId: "p1", name: "Changed", quantity: 1, unitPriceMinor: 9000 }];
  setup.advance(1_001);
  controls.sentTransitionError = undefined;
  const result = await setup.recovery.processBatch("tenant-1", 1);
  assert.equal(result.failed, 1);
  assert.equal(setup.row.outbox, originalOutbox);
  assert.equal(setup.row.outbox.message.currency, "AUD");
  assert.equal(setup.calls.sideEffects.size, 1);
});

test("a concurrent reclaim cannot acquire the renewed lease while send is active", async () => {
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const setup = harness({ consent: true, sendGate });
  const first = setup.recovery.processBatch("tenant-1", 1);
  await new Promise((resolve) => setImmediate(resolve));
  const contender = await setup.recovery.processBatch("tenant-1", 1);
  assert.equal(contender.busy, 1);
  releaseSend();
  assert.equal((await first).sent, 1);
});

test("atomic consent and suppression decision prevents sender access", async () => {
  const consent = harness({ consent: false });
  assert.equal((await consent.recovery.processBatch("tenant-1", 1)).suppressed, 1);
  const suppressed = harness({ consent: true, suppressed: true });
  assert.equal((await suppressed.recovery.processBatch("tenant-1", 1)).suppressed, 1);
  assert.equal(consent.calls.sends + suppressed.calls.sends, 0);
});

test("only one concurrent lease dispatches", async () => {
  const setup = harness({ consent: true });
  const [a, b] = await Promise.all([
    setup.recovery.processBatch("tenant-1", 1),
    setup.recovery.processBatch("tenant-1", 1),
  ]);
  assert.equal(a.sent + b.sent, 1);
  assert.equal(a.busy + b.busy, 1);
  assert.equal(setup.calls.sideEffects.size, 1);
});

test("sent transition crash replays one external side effect", async () => {
  const controls = { consent: true, sentTransitionError: "database down" };
  const setup = harness(controls);
  await assert.rejects(() => setup.recovery.processBatch("tenant-1", 1), /database down/);
  setup.advance(1_001);
  controls.sentTransitionError = undefined;
  await setup.recovery.processBatch("tenant-1", 1);
  assert.equal(setup.calls.sends, 2);
  assert.equal(setup.calls.sideEffects.size, 1);
});

test("stale fenced workers cannot transition after reclaim", async () => {
  const setup = harness({ consent: true });
  const first = await setup.store.claim({
    tenantId: "tenant-1", cartId: "cart-1", sequence: 1,
    now: new Date(Date.parse("2026-01-02T00:00:00Z")), leaseMs: 1_000, maxAttempts: 2,
  });
  setup.advance(1_001);
  const second = await setup.store.claim({
    tenantId: "tenant-1", cartId: "cart-1", sequence: 1,
    now: new Date(Date.parse("2026-01-02T00:00:01.001Z")), leaseMs: 1_000, maxAttempts: 2,
  });
  const identity = (cart) => ({
    tenantId: cart.tenantId, cartId: cart.cartId, sequence: cart.sequence,
    leaseToken: cart.leaseToken, fence: cart.fence,
  });
  assert.equal(await setup.store.markSent(identity(first)), false);
  assert.equal(await setup.store.markSent(identity(second)), true);
});

test("preserves sender and failure-transition errors together", async () => {
  const setup = harness({
    consent: true, senderError: "provider down", failTransitionError: "database down",
  });
  const error = await setup.recovery.processBatch("tenant-1", 1).catch((caught) => caught);
  assert.equal(error instanceof AggregateError, true);
  assert.deepEqual(error.errors.map(({ message }) => message), ["provider down", "database down"]);
});

test("rejects aggregate money overflow and times out ignored aborts", async () => {
  const overflow = harness({
    consent: true,
    lines: Array.from({ length: 91 }, (_, index) => ({
      productId: `p${index}`,
      name: "A",
      quantity: 10_000,
      unitPriceMinor: 10_000_000_000,
    })),
  });
  assert.equal((await overflow.recovery.processBatch("tenant-1", 1)).failed, 1);
  const timeout = harness({ consent: true, hangSender: true, operationTimeoutMs: 5 });
  assert.equal((await timeout.recovery.processBatch("tenant-1", 1)).failed, 1);
});
