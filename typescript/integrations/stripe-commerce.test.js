const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const test = require("node:test");
const {
  createStripeCheckout,
  processStripeWebhook,
} = require("../.test-dist/integrations/stripe-commerce.js");

const checkoutInput = {
  tenantId: "tenant-1",
  merchantId: "merchant-1",
  orderId: "order-1",
  idempotencyKey: "checkout-1",
  currency: "GBP",
  lines: [{ name: "Tile pack", unitAmountMinor: 1250, quantity: 2 }],
  metadata: { channel: "web" },
  successUrl: "https://shop.example/success",
  cancelUrl: "https://shop.example/cancel",
};

function checkoutHarness(overrides = {}) {
  const reservations = new Map();
  const sessions = new Map();
  const providerInputs = [];
  const store = {
    async begin(input) {
      if (overrides.hangBegin) return new Promise(() => {});
      const key = `${input.tenantId}\0${input.merchantId}\0${input.idempotencyKey}`;
      const reservation = reservations.get(key);
      if (!reservation) {
        reservations.set(key, { ...input });
        return {
          status: "reserved",
          requestHash: input.requestHash,
          requestVersion: input.requestVersion,
        };
      }
      if (reservation.requestHash !== input.requestHash) return { status: "conflict" };
      if (reservation.checkout) return { status: "completed", checkout: reservation.checkout };
      return {
        status: "resume",
        requestHash: overrides.badResumeHash ?? input.requestHash,
        requestVersion: input.requestVersion,
      };
    },
    async complete(input) {
      if (overrides.hangComplete) return new Promise(() => {});
      if (overrides.completeErrorOnce && !overrides.didFailComplete) {
        overrides.didFailComplete = true;
        throw new Error(overrides.completeErrorOnce);
      }
      if (overrides.completeError) throw new Error(overrides.completeError);
      const key = `${input.tenantId}\0${input.merchantId}\0${input.idempotencyKey}`;
      const reservation = reservations.get(key);
      reservation.checkout = structuredClone(input.checkout);
      return reservation.checkout;
    },
  };
  const provider = {
    async createCheckout(_input, key) {
      if (overrides.hangProvider) return new Promise(() => {});
      providerInputs.push(_input);
      if (overrides.providerError) throw new Error(overrides.providerError);
      if (!sessions.has(key)) {
        const number = sessions.size + 1;
        sessions.set(key, {
          sessionId: `cs_test_${number}`,
          url: overrides.providerUrl ?? `https://checkout.stripe.com/c/pay/cs_test_${number}`,
        });
      }
      return sessions.get(key);
    },
  };
  return { store, provider, sessions, providerInputs, reservations };
}

test("creates and durably replays one idempotent checkout", async () => {
  const { store, provider, sessions, providerInputs } = checkoutHarness();
  const first = await createStripeCheckout(store, provider, checkoutInput);
  const replay = await createStripeCheckout(store, provider, checkoutInput);
  assert.deepEqual(replay, first);
  assert.equal(sessions.size, 1);
  assert.equal(providerInputs[0].metadata.merchant_id, "merchant-1");
  assert.equal(providerInputs[0].metadata.order_id, "order-1");
  assert.equal(providerInputs[0].metadata.tenant_id, "tenant-1");
  assert.match(first.requestHash, /^[a-f0-9]{64}$/);
});

test("rejects checkout conflicts, amount/line maxima, and provider/completion failures", async () => {
  const conflict = checkoutHarness();
  await createStripeCheckout(conflict.store, conflict.provider, checkoutInput);
  await assert.rejects(
    () => createStripeCheckout(conflict.store, conflict.provider, {
      ...checkoutInput,
      lines: [{ ...checkoutInput.lines[0], quantity: 3 }],
    }),
    /conflicts/
  );
  await assert.rejects(
    () => createStripeCheckout(conflict.store, conflict.provider, {
      ...checkoutInput,
      lines: [{ ...checkoutInput.lines[0], unitAmountMinor: 0 }],
    }),
    /between 1/
  );
  await assert.rejects(
    () => createStripeCheckout(conflict.store, conflict.provider, {
      ...checkoutInput,
      idempotencyKey: "too-many",
      lines: Array.from({ length: 101 }, () => checkoutInput.lines[0]),
    }),
    /1 to 100/
  );
  const providerFailure = checkoutHarness({ providerError: "Stripe unavailable" });
  await assert.rejects(
    () => createStripeCheckout(providerFailure.store, providerFailure.provider, checkoutInput),
    /Stripe unavailable/
  );
  const completeFailure = checkoutHarness({ completeError: "ledger unavailable" });
  await assert.rejects(
    () => createStripeCheckout(completeFailure.store, completeFailure.provider, checkoutInput),
    /ledger unavailable/
  );
  const badResume = checkoutHarness({ badResumeHash: "bad", completeErrorOnce: "crash" });
  await assert.rejects(
    () => createStripeCheckout(badResume.store, badResume.provider, checkoutInput),
    /crash/
  );
  await assert.rejects(
    () => createStripeCheckout(badResume.store, badResume.provider, checkoutInput),
    /invalid reservation state/
  );
});

test("completion crash resumes through one idempotent provider session and tenants stay isolated", async () => {
  const controls = { completeErrorOnce: "ledger crash" };
  const harness = checkoutHarness(controls);
  await assert.rejects(
    () => createStripeCheckout(harness.store, harness.provider, checkoutInput),
    /ledger crash/
  );
  const resumed = await createStripeCheckout(harness.store, harness.provider, checkoutInput);
  const otherTenant = await createStripeCheckout(
    harness.store,
    harness.provider,
    { ...checkoutInput, tenantId: "tenant-2" }
  );
  assert.equal(resumed.sessionId, "cs_test_1");
  assert.equal(otherTenant.sessionId, "cs_test_2");
  assert.equal(harness.sessions.size, 2);
});

test("rejects unapproved checkout origins and bounds stalled provider work", async () => {
  const wrongOrigin = checkoutHarness({ providerUrl: "https://checkout.stripe.com.evil.test/x" });
  await assert.rejects(
    () => createStripeCheckout(wrongOrigin.store, wrongOrigin.provider, checkoutInput),
    /approved Stripe Checkout origin/
  );
  const stalled = checkoutHarness();
  stalled.provider.createCheckout = async (_input, _key, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("provider aborted")));
  });
  await assert.rejects(
    () => createStripeCheckout(stalled.store, stalled.provider, checkoutInput, { timeoutMs: 5 }),
    /timed out|aborted/
  );
});

function webhook(body, timestamp, secret = "whsec_primary") {
  const raw = new TextEncoder().encode(JSON.stringify(body));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(raw)
    .digest("hex");
  return { raw, header: `t=${timestamp},v1=${signature}` };
}

function transitionStore(overrides = {}) {
  const events = new Map();
  const payments = new Map();
  return {
    events,
    store: {
      async applyEventOnce(input) {
        if (overrides.hangApply) return new Promise(() => {});
        if (overrides.error) throw new Error(overrides.error);
        const existing = events.get(input.eventId);
        if (existing) {
          if (existing.hash !== input.eventHash) throw new Error("event fingerprint conflict");
          return {
            applied: false,
            eventId: input.eventId,
            eventHash: overrides.badEventHash ?? input.eventHash,
            state: payments.get(existing.paymentKey),
            expectedCheckoutSessionId: payments.get(existing.paymentKey).checkoutSessionId,
          };
        }
        const transition = input.transition;
        const paymentKey = `${transition.tenantId}\0${transition.merchantId}\0${transition.orderId}`;
        let state;
        let expectedCheckoutSessionId;
        if (transition.kind === "paid") {
          expectedCheckoutSessionId = transition.checkoutSessionId;
          state = {
            tenantId: transition.tenantId,
            merchantId: transition.merchantId,
            orderId: transition.orderId,
            status: "paid",
            currency: transition.currency,
            paidAmountMinor: transition.paidAmountMinor,
            refundedAmountMinor: 0,
            stateVersion: input.stateVersion,
            checkoutSessionId: transition.checkoutSessionId,
            paymentIntentId: transition.paymentIntentId,
          };
        } else {
          const current = payments.get(paymentKey);
          if (!current ||
              current.currency !== transition.currency ||
              current.paidAmountMinor !== transition.paidAmountMinor ||
              current.paymentIntentId !== transition.paymentIntentId) {
            throw new Error("refund does not match persisted payment");
          }
          expectedCheckoutSessionId = current.checkoutSessionId;
          if (transition.refundedAmountMinor < current.refundedAmountMinor) {
            throw new Error("refund cumulative amount regressed");
          }
          if (transition.refundedAmountMinor === current.refundedAmountMinor) {
            events.set(input.eventId, { hash: input.eventHash, paymentKey });
            return {
              applied: false,
              eventId: input.eventId,
              eventHash: input.eventHash,
              state: structuredClone(current),
              expectedCheckoutSessionId: current.checkoutSessionId,
            };
          }
          state = {
            ...current,
            status: transition.refundedAmountMinor === current.paidAmountMinor
              ? "refunded"
              : "partially_refunded",
            refundedAmountMinor: transition.refundedAmountMinor,
            latestChargeId: transition.chargeId,
          };
        }
        if (overrides.mutateState) state = overrides.mutateState(state);
        payments.set(paymentKey, structuredClone(state));
        events.set(input.eventId, { hash: input.eventHash, paymentKey });
        return {
          applied: true,
          eventId: input.eventId,
          eventHash: overrides.badEventHash ?? input.eventHash,
          state,
          expectedCheckoutSessionId,
        };
      },
    },
  };
}

test("verifies rotated raw-byte signatures and atomically records paid/refunded evidence", async () => {
  const now = 1_700_000_000;
  const transitions = transitionStore();
  const paidEvent = {
    id: "evt_paid",
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_1", payment_status: "paid", amount_total: 2500, currency: "gbp",
      payment_intent: "pi_1",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  };
  const paid = webhook(paidEvent, now, "whsec_rotated");
  const webhookOptions = {
    secrets: ["whsec_primary", "whsec_rotated"],
    store: transitions.store,
    now: () => now * 1000,
  };
  const [first, replay] = await Promise.all([
    processStripeWebhook(paid.raw, paid.header, webhookOptions),
    processStripeWebhook(paid.raw, paid.header, webhookOptions),
  ]);
  assert.equal(first.state.status, "paid");
  assert.equal(replay.applied, false);

  const refund = webhook({
    id: "evt_refund",
    type: "charge.refunded",
    data: { object: {
      id: "ch_1", amount: 2500, amount_refunded: 1000, currency: "gbp",
      payment_intent: "pi_1",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  }, now);
  const refunded = await processStripeWebhook(refund.raw, refund.header, {
    secrets: ["whsec_primary"],
    store: transitions.store,
    now: () => now * 1000,
  });
  assert.equal(refunded.state.status, "partially_refunded");
  assert.equal(refunded.state.refundedAmountMinor, 1000);
});

test("rejects invalid signatures/timestamps and propagates transition failures", async () => {
  const now = 1_700_000_000;
  const event = {
    id: "evt_1",
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_1", payment_status: "paid", amount_total: 100, currency: "gbp",
      payment_intent: "pi_1",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  };
  const signed = webhook(event, now);
  await assert.rejects(
    () => processStripeWebhook(signed.raw, signed.header.replace(/[a-f0-9]$/, "f"), {
      secrets: ["wrong"], store: transitionStore().store, now: () => now * 1000,
    }),
    /signature is invalid/
  );
  await assert.rejects(
    () => processStripeWebhook(signed.raw, signed.header, {
      secrets: ["whsec_primary"], store: transitionStore().store, now: () => (now + 301) * 1000,
    }),
    /outside tolerance/
  );
  await assert.rejects(
    () => processStripeWebhook(signed.raw, signed.header, {
      secrets: ["whsec_primary"],
      store: transitionStore({ error: "database unavailable" }).store,
      now: () => now * 1000,
    }),
    /database unavailable/
  );
  await assert.rejects(
    () => processStripeWebhook(signed.raw, signed.header, {
      secrets: ["whsec_primary"],
      store: transitionStore({ badEventHash: "bad" }).store,
      now: () => now * 1000,
    }),
    /invalid state/
  );
  await assert.rejects(
    () => processStripeWebhook(signed.raw, signed.header, {
      secrets: ["whsec_primary"],
      store: transitionStore({
        mutateState: (state) => ({ ...state, paidAmountMinor: state.paidAmountMinor + 1 }),
      }).store,
      now: () => now * 1000,
    }),
    /immutable payment evidence/
  );
});

test("refund evidence must match the persisted tenant, order, money, and provider lineage", async () => {
  const now = 1_700_000_000;
  const transitions = transitionStore();
  const paid = webhook({
    id: "evt_paid_match",
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_match", payment_status: "paid", amount_total: 500, currency: "gbp",
      payment_intent: "pi_match",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  }, now);
  await processStripeWebhook(paid.raw, paid.header, {
    secrets: ["whsec_primary"], store: transitions.store, now: () => now * 1000,
  });
  for (const change of [
    { order_id: "order-2" },
    { tenant_id: "tenant-2" },
  ]) {
    const refund = webhook({
      id: `evt_${Object.values(change)[0]}`,
      type: "charge.refunded",
      data: { object: {
        id: "ch_bad", amount: 500, amount_refunded: 100, currency: "gbp",
        payment_intent: "pi_match",
        metadata: {
          tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1", ...change,
        },
      } },
    }, now);
    await assert.rejects(
      () => processStripeWebhook(refund.raw, refund.header, {
        secrets: ["whsec_primary"], store: transitions.store, now: () => now * 1000,
      }),
      /does not match/
    );
  }
  for (const [eventId, amount, paymentIntent] of [
    ["evt_bad_money", 501, "pi_match"],
    ["evt_bad_lineage", 500, "pi_other"],
  ]) {
    const refund = webhook({
      id: eventId,
      type: "charge.refunded",
      data: { object: {
        id: "ch_bad", amount, amount_refunded: 100, currency: "gbp",
        payment_intent: paymentIntent,
        metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
      } },
    }, now);
    await assert.rejects(
      () => processStripeWebhook(refund.raw, refund.header, {
        secrets: ["whsec_primary"], store: transitions.store, now: () => now * 1000,
      }),
      /does not match/
    );
  }
});

test("cumulative refunds are monotonic under out-of-order and concurrent delivery", async () => {
  const now = 1_700_000_000;
  const transitions = transitionStore();
  const options = { secrets: ["whsec_primary"], store: transitions.store, now: () => now * 1000 };
  const paid = webhook({
    id: "evt_paid_monotonic", type: "checkout.session.completed",
    data: { object: {
      id: "cs_monotonic", payment_status: "paid", amount_total: 2500, currency: "gbp",
      payment_intent: "pi_monotonic",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  }, now);
  await processStripeWebhook(paid.raw, paid.header, options);
  const refund = (id, amount) => webhook({
    id, type: "charge.refunded",
    data: { object: {
      id: `ch_${amount}`, amount: 2500, amount_refunded: amount, currency: "gbp",
      payment_intent: "pi_monotonic",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  }, now);
  const first = refund("evt_refund_1000", 1000);
  await processStripeWebhook(first.raw, first.header, options);
  const equal = refund("evt_refund_equal", 1000);
  assert.equal((await processStripeWebhook(equal.raw, equal.header, options)).applied, false);
  const lower = refund("evt_refund_lower", 500);
  await assert.rejects(
    () => processStripeWebhook(lower.raw, lower.header, options),
    /regressed/
  );
  const high = refund("evt_refund_2000", 2000);
  const stale = refund("evt_refund_1500", 1500);
  const outcomes = await Promise.allSettled([
    processStripeWebhook(high.raw, high.header, options),
    processStripeWebhook(stale.raw, stale.header, options),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[0].value.state.refundedAmountMinor, 2000);
  assert.equal(outcomes[1].status, "rejected");
});

test("an older refund event replays against newer cumulative state", async () => {
  const now = 1_700_000_000;
  const transitions = transitionStore();
  const options = { secrets: ["whsec_primary"], store: transitions.store, now: () => now * 1000 };
  const paid = webhook({
    id: "evt_paid_replay", type: "checkout.session.completed",
    data: { object: {
      id: "cs_replay", payment_status: "paid", amount_total: 2500, currency: "gbp",
      payment_intent: "pi_replay",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  }, now);
  await processStripeWebhook(paid.raw, paid.header, options);
  const refund = (id, amount) => webhook({
    id, type: "charge.refunded",
    data: { object: {
      id: `ch_${amount}`, amount: 2500, amount_refunded: amount, currency: "gbp",
      payment_intent: "pi_replay",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  }, now);
  const older = refund("evt_refund_old", 500);
  const newer = refund("evt_refund_new", 1500);
  await processStripeWebhook(older.raw, older.header, options);
  await processStripeWebhook(newer.raw, newer.header, options);
  const replay = await processStripeWebhook(older.raw, older.header, options);
  assert.equal(replay.applied, false);
  assert.equal(replay.state.refundedAmountMinor, 1500);
  assert.equal(replay.state.latestChargeId, "ch_1500");
});

test("refund validation rejects a mutated checkout-session lineage", async () => {
  const now = 1_700_000_000;
  const controls = {
    mutateState: (state) => state.status === "paid"
      ? state
      : { ...state, checkoutSessionId: "cs_mutated" },
  };
  const transitions = transitionStore(controls);
  const options = { secrets: ["whsec_primary"], store: transitions.store, now: () => now * 1000 };
  const paid = webhook({
    id: "evt_paid_lineage", type: "checkout.session.completed",
    data: { object: {
      id: "cs_expected", payment_status: "paid", amount_total: 500, currency: "gbp",
      payment_intent: "pi_lineage",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  }, now);
  await processStripeWebhook(paid.raw, paid.header, options);
  const refund = webhook({
    id: "evt_refund_lineage", type: "charge.refunded",
    data: { object: {
      id: "ch_lineage", amount: 500, amount_refunded: 100, currency: "gbp",
      payment_intent: "pi_lineage",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  }, now);
  await assert.rejects(
    () => processStripeWebhook(refund.raw, refund.header, options),
    /provider lineage/
  );
});

test("hard deadlines bound ignored-abort checkout and webhook adapters", async () => {
  for (const stage of ["hangBegin", "hangProvider", "hangComplete"]) {
    const harness = checkoutHarness({ [stage]: true });
    await assert.rejects(
      () => createStripeCheckout(harness.store, harness.provider, checkoutInput, { timeoutMs: 5 }),
      /timed out|aborted/
    );
  }
  const now = 1_700_000_000;
  const paid = webhook({
    id: "evt_hang_apply", type: "checkout.session.completed",
    data: { object: {
      id: "cs_hang", payment_status: "paid", amount_total: 100, currency: "gbp",
      payment_intent: "pi_hang",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  }, now);
  await assert.rejects(
    () => processStripeWebhook(paid.raw, paid.header, {
      secrets: ["whsec_primary"],
      store: transitionStore({ hangApply: true }).store,
      now: () => now * 1000,
      timeoutMs: 5,
    }),
    /timed out|aborted/
  );
  const controller = new AbortController();
  controller.abort();
  let begins = 0;
  await assert.rejects(
    () => createStripeCheckout(
      { begin: async () => { begins++; return new Promise(() => {}); }, complete: async () => { throw new Error(); } },
      { createCheckout: async () => { throw new Error(); } },
      checkoutInput,
      { signal: controller.signal }
    ),
    /timed out|aborted/
  );
  assert.equal(begins, 0);
});

test("active external abort propagates to hung checkout and webhook adapters", async () => {
  const checkoutController = new AbortController();
  let checkoutSignal;
  const checkoutPromise = createStripeCheckout(
    {
      begin: async (_input, signal) => {
        checkoutSignal = signal;
        return new Promise(() => {});
      },
      complete: async () => { throw new Error("unreachable"); },
    },
    { createCheckout: async () => { throw new Error("unreachable"); } },
    checkoutInput,
    { signal: checkoutController.signal, timeoutMs: 1000 }
  );
  await new Promise((resolve) => setImmediate(resolve));
  checkoutController.abort();
  await assert.rejects(() => checkoutPromise, /timed out|aborted/);
  assert.equal(checkoutSignal.aborted, true);

  const now = 1_700_000_000;
  const paid = webhook({
    id: "evt_external_abort", type: "checkout.session.completed",
    data: { object: {
      id: "cs_abort", payment_status: "paid", amount_total: 100, currency: "gbp",
      payment_intent: "pi_abort",
      metadata: { tenant_id: "tenant-1", merchant_id: "merchant-1", order_id: "order-1" },
    } },
  }, now);
  const webhookController = new AbortController();
  let webhookSignal;
  const webhookPromise = processStripeWebhook(paid.raw, paid.header, {
    secrets: ["whsec_primary"],
    store: {
      applyEventOnce: async (_input, signal) => {
        webhookSignal = signal;
        return new Promise(() => {});
      },
    },
    now: () => now * 1000,
    timeoutMs: 1000,
    signal: webhookController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  webhookController.abort();
  await assert.rejects(() => webhookPromise, /timed out|aborted/);
  assert.equal(webhookSignal.aborted, true);
});
