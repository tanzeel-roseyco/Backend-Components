const assert = require("node:assert/strict");
const test = require("node:test");
const { QuoteDocumentWorkflow } = require("../.test-dist/business-logic/quote-document-workflow.js");

function harness(behavior = {}) {
  const jobs = new Map();
  const effects = { extracts: [], renders: [], deliveries: [], renewals: 0 };
  let nextFence = 0;
  const jobKey = (tenant, job) => `${tenant}:${job}`;
  const store = {
    claimPreparation: async (tenant, job, requestHash) => {
      if (behavior.hangClaim) await new Promise(() => {});
      const key = jobKey(tenant, job);
      const existing = jobs.get(key);
      if (existing?.snapshot) return { kind: "existing", snapshot: existing.snapshot };
      if (existing?.claimed && !behavior.allowReclaim) return { kind: "busy" };
      const fence = ++nextFence;
      jobs.set(key, { claimed: true, fence, requestHash });
      return { kind: "claimed", fence };
    },
    renewLease: async (tenant, job, fence) => {
      effects.renewals++;
      const row = jobs.get(jobKey(tenant, job));
      return !behavior.loseLease && row?.fence === fence;
    },
    savePrepared: async (tenant, job, fence, quote, artifacts) => {
      const row = jobs.get(jobKey(tenant, job));
      if (!row || row.fence !== fence) throw new Error("stale fence");
      const snapshot = behavior.malformedPrepared ?? {
        tenantId: tenant, jobId: job, state: "pending_approval",
        requestHash: row.requestHash, quote, artifacts,
      };
      row.snapshot = snapshot;
      row.claimed = false;
      return snapshot;
    },
    approveOnce: async (tenant, job, approval) => {
      const row = jobs.get(jobKey(tenant, job));
      if (!row?.snapshot) throw new Error("missing job");
      if (row.snapshot.state === "pending_approval") {
        row.snapshot = { ...row.snapshot, state: "approved", approvalId: approval };
      }
      if (row.snapshot.approvalId !== approval) throw new Error("approval mismatch");
      return row.snapshot;
    },
    claimDelivery: async (tenant, job, approval, requestHash) => {
      const row = jobs.get(jobKey(tenant, job));
      if (!row?.snapshot || row.snapshot.approvalId !== approval) throw new Error("approval required");
      if (row.snapshot.deliveryRequestHash && row.snapshot.deliveryRequestHash !== requestHash) {
        throw new Error("delivery request hash mismatch");
      }
      if (row.snapshot.state === "delivered") return { kind: "existing", snapshot: row.snapshot };
      if (row.deliveryClaimed && !behavior.allowReclaim) return { kind: "busy" };
      row.deliveryClaimed = true;
      row.snapshot = { ...row.snapshot, state: "delivering", deliveryRequestHash: requestHash };
      row.fence = ++nextFence;
      return { kind: "claimed", fence: row.fence };
    },
    saveDelivered: async (tenant, job, fence, requestHash, deliveryId) => {
      const row = jobs.get(jobKey(tenant, job));
      if (!row || row.fence !== fence) throw new Error("stale fence");
      row.snapshot = behavior.malformedDelivered ?? {
        ...row.snapshot, tenantId: tenant, jobId: job, state: "delivered",
        deliveryRequestHash: requestHash, deliveryId,
      };
      row.deliveryClaimed = false;
      return row.snapshot;
    },
  };
  const extractor = {
    extract: async (input) => {
      effects.extracts.push({ key: input.idempotencyKey, bytes: [...input.document.content] });
      if (behavior.slowExtract) await new Promise((resolve) => setTimeout(resolve, behavior.slowExtract));
      if (behavior.extractFailure) throw new Error("extract failed");
      return behavior.lines ?? [{ description: "Paint walls", quantity: 2, unitPriceCents: 12500 }];
    },
  };
  const renderer = {
    render: async (input) => {
      effects.renders.push(input.idempotencyKey);
      if (behavior.slowRender) await new Promise((resolve) => setTimeout(resolve, behavior.slowRender));
      return { pdf: new Uint8Array([1, 2]), xlsx: new Uint8Array([3, 4]) };
    },
  };
  const delivered = new Map();
  const delivery = {
    deliver: async (input) => {
      effects.deliveries.push(input.idempotencyKey);
      if (behavior.deliveryGates?.length) await behavior.deliveryGates.shift();
      if (behavior.deliveryFailure) throw new Error("delivery failed");
      if (!delivered.has(input.idempotencyKey)) delivered.set(input.idempotencyKey, `mail-${delivered.size + 1}`);
      return { deliveryId: delivered.get(input.idempotencyKey) };
    },
  };
  const workflow = new QuoteDocumentWorkflow(store, extractor, renderer, delivery, {
    operationTimeoutMs: behavior.operationTimeoutMs ?? 50,
    totalTimeoutMs: behavior.totalTimeoutMs ?? 500,
    leaseMs: behavior.leaseMs ?? 1000,
    maxDocumentBytes: 100,
  });
  return {
    workflow, store, jobs, effects, behavior,
    document: { name: "takeoff.pdf", mimeType: "application/pdf", content: new Uint8Array([7, 8]) },
  };
}

test("tenant-scoped preparation, approval, delivery, and replay succeed", async () => {
  const setup = harness();
  const prepared = await setup.workflow.prepare("tenant-1", "job-1", setup.document);
  assert.equal(prepared.quote.subtotalCents, 25000);
  await setup.workflow.approve("tenant-1", "job-1", "approval-1");
  const sent = await setup.workflow.deliver("tenant-1", "job-1", "approval-1", "buyer@example.com");
  const replay = await setup.workflow.deliver("tenant-1", "job-1", "approval-1", "buyer@example.com");
  assert.equal(sent.deliveryId, replay.deliveryId);
  assert.equal(setup.effects.deliveries.length, 1);
  assert.match(setup.effects.deliveries[0], /^quote-delivery:v2:/);
});

test("same job ID is isolated by tenant and cross-tenant snapshots are rejected", async () => {
  const setup = harness();
  await setup.workflow.prepare("tenant-1", "job-1", setup.document);
  await setup.workflow.prepare("tenant-2", "job-1", setup.document);
  assert.equal(setup.effects.extracts.length, 2);
  const row = setup.jobs.get("tenant-1:job-1");
  row.snapshot = { ...row.snapshot, tenantId: "tenant-evil" };
  await assert.rejects(
    () => setup.workflow.prepare("tenant-1", "job-1", setup.document),
    /cross-tenant/,
  );
});

test("copies input before awaiting and binds delivery hash to recipient and artifacts", async () => {
  const setup = harness({ slowExtract: 5 });
  const pending = setup.workflow.prepare("tenant-1", "job-1", setup.document);
  setup.document.content[0] = 99;
  await pending;
  assert.deepEqual(setup.effects.extracts[0].bytes, [7, 8]);
  await setup.workflow.approve("tenant-1", "job-1", "approval-1");
  await setup.workflow.deliver("tenant-1", "job-1", "approval-1", "one@example.com");
  await assert.rejects(
    () => setup.workflow.deliver("tenant-1", "job-1", "approval-1", "two@example.com"),
    /hash mismatch/,
  );
});

test("malformed extraction and persisted snapshots fail closed", async () => {
  const extraction = harness({ lines: [{ description: "", quantity: 1, unitPriceCents: 1 }] });
  await assert.rejects(
    () => extraction.workflow.prepare("tenant-1", "job-1", extraction.document),
    /description/,
  );
  const malformed = harness();
  malformed.behavior.malformedPrepared = {
    tenantId: "tenant-1", jobId: "job-1", state: "pending_approval", requestHash: "wrong",
  };
  await assert.rejects(
    () => malformed.workflow.prepare("tenant-1", "job-1", malformed.document),
    /malformed/,
  );
});

test("atomic claims, stale-fence reclaim, and provider crash replay are safe", async () => {
  const busy = harness();
  busy.jobs.set("tenant-1:job-1", { claimed: true, fence: 1, requestHash: "x" });
  await assert.rejects(
    () => busy.workflow.prepare("tenant-1", "job-1", busy.document),
    /already processing/,
  );
  const crash = harness({ deliveryFailure: true });
  await crash.workflow.prepare("tenant-1", "job-1", crash.document);
  await crash.workflow.approve("tenant-1", "job-1", "approval-1");
  await assert.rejects(
    () => crash.workflow.deliver("tenant-1", "job-1", "approval-1", "buyer@example.com"),
    /delivery failed/,
  );
  crash.behavior.deliveryFailure = false;
  crash.behavior.allowReclaim = true;
  const delivered = await crash.workflow.deliver("tenant-1", "job-1", "approval-1", "buyer@example.com");
  assert.equal(delivered.state, "delivered");
  assert.equal(crash.effects.deliveries[0], crash.effects.deliveries[1]);
});

test("heartbeat loss and ignored-abort provider timeouts reject stale work", async () => {
  const lost = harness({
    slowExtract: 400, leaseMs: 1000, operationTimeoutMs: 800, totalTimeoutMs: 1200, loseLease: true,
  });
  await assert.rejects(
    () => lost.workflow.prepare("tenant-1", "job-1", lost.document),
    /lease was lost/,
  );
  assert.ok(lost.effects.renewals > 0);
  const timeout = harness({ slowExtract: 100, operationTimeoutMs: 5 });
  await assert.rejects(
    () => timeout.workflow.prepare("tenant-1", "job-1", timeout.document),
    /extraction timed out/,
  );
});

test("saved delivered snapshot must retain the requested approval", async () => {
  const setup = harness();
  await setup.workflow.prepare("tenant-1", "job-1", setup.document);
  await setup.workflow.approve("tenant-1", "job-1", "approval-1");
  const row = setup.jobs.get("tenant-1:job-1");
  setup.behavior.malformedDelivered = {
    ...row.snapshot,
    state: "delivered",
    approvalId: "approval-other",
    deliveryRequestHash: "quote-delivery-request:v2:" + "a".repeat(64),
    deliveryId: "mail-1",
  };
  await assert.rejects(
    () => setup.workflow.deliver("tenant-1", "job-1", "approval-1", "buyer@example.com"),
    /mismatched delivery state/,
  );
});

test("old in-flight delivery cannot save after a newer fence reclaims and completes", async () => {
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const setup = harness({ deliveryGates: [oldGate] });
  await setup.workflow.prepare("tenant-1", "job-1", setup.document);
  await setup.workflow.approve("tenant-1", "job-1", "approval-1");
  const old = setup.workflow.deliver("tenant-1", "job-1", "approval-1", "buyer@example.com");
  while (setup.effects.deliveries.length < 1) await new Promise((resolve) => setImmediate(resolve));
  setup.behavior.allowReclaim = true;
  const newer = await setup.workflow.deliver("tenant-1", "job-1", "approval-1", "buyer@example.com");
  releaseOld();
  await assert.rejects(() => old, /stale fence/);
  assert.equal(newer.state, "delivered");
  assert.equal(setup.effects.deliveries[0], setup.effects.deliveries[1]);
});

test("ignored-abort stores and multi-operation sequences respect hard budgets", async () => {
  const hangingStore = harness({ hangClaim: true, operationTimeoutMs: 5, totalTimeoutMs: 50 });
  await assert.rejects(
    () => hangingStore.workflow.prepare("tenant-1", "job-1", hangingStore.document),
    /claim preparation timed out/,
  );

  const total = harness({
    slowExtract: 12,
    slowRender: 12,
    operationTimeoutMs: 15,
    totalTimeoutMs: 18,
  });
  await assert.rejects(
    () => total.workflow.prepare("tenant-1", "job-1", total.document),
    /quote preparation timed out/,
  );
});
