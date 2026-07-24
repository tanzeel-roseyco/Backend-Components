const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { ResumableFileTransfer } = require("../.test-dist/infrastructure/resumable-file-transfer.js");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function harness(options = {}) {
  const content = options.content ?? Uint8Array.from([1, 2, 3, 4, 5]);
  const row = {
    id: "transfer-1", tenantId: "tenant-1", sourceKey: "source", copyKey: "copy",
    sizeBytes: content.length, checksumSha256: digest(content), status: "pending",
    attempts: 0, offset: 0, leaseToken: "", fence: 0,
  };
  const remote = { sessionId: "session-1", offset: options.remoteOffset ?? 0, bytes: [] };
  const calls = { appends: [], errors: 0, completes: 0 };
  let now = 1_000_000;

  const owns = (lease) =>
    row.status === "copying" && lease.tenantId === row.tenantId &&
    lease.transferId === row.id && lease.leaseToken === row.leaseToken && lease.fence === row.fence;
  const store = {
    async claim(input) {
      if (input.tenantId !== row.tenantId || input.transferId !== row.id || row.status === "complete") return null;
      if (row.status === "copying" && row.leaseUntil > input.now.getTime()) return null;
      if (row.attempts >= input.maxAttempts) return null;
      row.status = "copying";
      row.attempts++;
      row.fence++;
      row.leaseToken = `lease-${row.fence}`;
      row.leaseUntil = input.now.getTime() + input.leaseMs;
      return { ...row, ...(options.wrongClaimTenant && { tenantId: "tenant-2" }) };
    },
    async renew(lease, current, leaseMs) {
      if (!owns(lease)) return false;
      row.leaseUntil = current.getTime() + leaseMs;
      return true;
    },
    async findCompletedByCopyKey(tenantId, copyKey) {
      return options.duplicate?.tenantId === tenantId && options.duplicate.copyKey === copyKey
        ? options.duplicate : null;
    },
    async saveProgress(lease, expected, next, sessionId) {
      if (!owns(lease) || row.offset !== expected) return false;
      row.offset = next;
      row.sessionId = sessionId;
      return true;
    },
    async markComplete(lease, destinationId, sizeBytes, checksumSha256) {
      if (!owns(lease)) return false;
      Object.assign(row, { status: "complete", destinationId, sizeBytes, checksumSha256 });
      calls.completes++;
      return true;
    },
    async markError(lease) {
      if (!owns(lease)) return false;
      row.status = "error";
      calls.errors++;
      return true;
    },
    async listStranded(tenantId, _current, limit) {
      return tenantId === row.tenantId ? (options.stranded ?? []).slice(0, limit) : [];
    },
  };
  const source = {
    async readChunk(tenantId, _key, offset, length) {
      assert.equal(tenantId, row.tenantId);
      if (options.hangRead) return new Promise(() => {});
      const result = content.slice(offset, offset + length);
      if (options.corrupt && offset === 0) result[0] ^= 1;
      return result;
    },
  };
  const destination = {
    async beginOrResume(input) {
      assert.equal(input.tenantId, row.tenantId);
      if (options.completedSession) {
        return { sessionId: remote.sessionId, offset: content.length, completed: options.completedSession };
      }
      return { sessionId: remote.sessionId, offset: remote.offset };
    },
    async append(_tenant, _session, _fence, offset, bytes) {
      calls.appends.push(offset);
      if (options.crashAfterAppend && calls.appends.length === 1) {
        remote.offset = offset + bytes.length;
        throw new Error("worker crashed after remote append");
      }
      if (offset !== remote.offset) throw new Error("remote offset conflict");
      remote.bytes.push(...bytes);
      remote.offset += bytes.length;
      return remote.offset;
    },
    async complete() {
      if (options.completeFailure) throw new Error("complete failed");
      if (options.advanceBeforeComplete) now += options.advanceBeforeComplete;
      return {
        destinationId: "destination-1",
        sizeBytes: content.length,
        checksumSha256: options.destinationChecksum ?? digest(content),
      };
    },
  };
  const transfer = new ResumableFileTransfer(store, source, destination, {
    chunkSize: 2, leaseMs: 1_000, operationTimeoutMs: options.operationTimeoutMs ?? 50,
    totalTimeoutMs: options.totalTimeoutMs ?? 5_000,
    maxAttempts: 3, maxReconcileBatch: 2, now: () => now,
  });
  return { transfer, row, remote, calls, store, source, destination, advance: (ms) => { now += ms; } };
}

test("uploads exact chunks, hashes source bytes, and completes under a fenced lease", async () => {
  const setup = harness();
  const result = await setup.transfer.process("tenant-1", "transfer-1");
  assert.deepEqual(result, { status: "complete", destinationId: "destination-1", duplicate: false });
  assert.deepEqual(setup.calls.appends, [0, 2, 4]);
  assert.equal(setup.row.offset, 5);
});

test("resumes remote-ahead progress and recovers a crash after append", async () => {
  const resumed = harness({ remoteOffset: 4 });
  resumed.row.offset = 2;
  resumed.row.sessionId = "session-1";
  await resumed.transfer.process("tenant-1", "transfer-1");
  assert.deepEqual(resumed.calls.appends, [4]);

  const crashed = harness({ crashAfterAppend: true });
  await assert.rejects(() => crashed.transfer.process("tenant-1", "transfer-1"), /crashed/);
  crashed.advance(1_001);
  await crashed.transfer.process("tenant-1", "transfer-1");
  assert.equal(crashed.row.status, "complete");
});

test("stale workers cannot complete or mark error after reclaim", async () => {
  const setup = harness();
  const first = await setup.store.claim({
    tenantId: "tenant-1", transferId: "transfer-1", now: new Date(1_000_000),
    leaseMs: 1_000, maxAttempts: 3,
  });
  setup.advance(1_001);
  const second = await setup.store.claim({
    tenantId: "tenant-1", transferId: "transfer-1", now: new Date(1_001_001),
    leaseMs: 1_000, maxAttempts: 3,
  });
  const identity = (record) => ({
    tenantId: record.tenantId, transferId: record.id,
    leaseToken: record.leaseToken, fence: record.fence,
  });
  assert.equal(await setup.store.markComplete(identity(first), "old", 5, digest(Uint8Array.from([1,2,3,4,5]))), false);
  assert.equal(await setup.store.markError(identity(first)), false);
  assert.equal(await setup.store.markComplete(identity(second), "new", 5, digest(Uint8Array.from([1,2,3,4,5]))), true);
});

test("rejects wrong tenants and independently mismatched checksums", async () => {
  const tenant = harness();
  assert.deepEqual(await tenant.transfer.process("tenant-2", "transfer-1"), { status: "busy" });
  const wrongClaim = harness({ wrongClaimTenant: true });
  await assert.rejects(
    () => wrongClaim.transfer.process("tenant-1", "transfer-1"),
    /wrong tenant/
  );
  const corrupt = harness({ corrupt: true });
  await assert.rejects(() => corrupt.transfer.process("tenant-1", "transfer-1"), /source checksum/);
  const destination = harness({ destinationChecksum: "0".repeat(64) });
  await assert.rejects(() => destination.transfer.process("tenant-1", "transfer-1"), /destination checksum/);
});

test("operation deadlines reject adapters that ignore abort", async () => {
  const setup = harness({ hangRead: true, operationTimeoutMs: 5 });
  await assert.rejects(() => setup.transfer.process("tenant-1", "transfer-1"), /timed out/);
  assert.equal(setup.calls.errors, 1);
});

test("all stateful transfer boundaries reject adapters that ignore abort", async (t) => {
  const never = () => new Promise(() => {});
  const cases = [
    ["claim", (setup) => { setup.store.claim = never; }],
    ["renew", (setup) => { setup.store.renew = never; }],
    ["append", (setup) => { setup.destination.append = never; }],
    ["save", (setup) => { setup.store.saveProgress = never; }],
    ["complete", (setup) => { setup.destination.complete = never; }],
    ["mark complete", (setup) => { setup.store.markComplete = never; }],
    ["mark error", (setup) => {
      setup.source.readChunk = never;
      setup.store.markError = never;
    }],
  ];
  for (const [name, arrange] of cases) {
    await t.test(name, async () => {
      const setup = harness({ operationTimeoutMs: 5 });
      arrange(setup);
      await assert.rejects(
        () => setup.transfer.process("tenant-1", "transfer-1"),
        /timed out/,
      );
      assert.notEqual(setup.row.status, "complete");
    });
  }
});

test("total budget remains anchored through the final mark-complete transition", async () => {
  const setup = harness({
    advanceBeforeComplete: 101,
    operationTimeoutMs: 50,
    totalTimeoutMs: 100,
  });
  await assert.rejects(
    () => setup.transfer.process("tenant-1", "transfer-1"),
    /total timeout/,
  );
  assert.equal(setup.calls.completes, 0);
  assert.equal(setup.calls.errors, 1);
});

test("an in-flight fence loss cannot save progress, complete, or mark an error", async () => {
  const setup = harness();
  const originalAppend = setup.destination.append;
  setup.destination.append = async (...args) => {
    const nextOffset = await originalAppend(...args);
    setup.row.fence++;
    setup.row.leaseToken = `lease-${setup.row.fence}`;
    return nextOffset;
  };
  await assert.rejects(
    () => setup.transfer.process("tenant-1", "transfer-1"),
    /lease was lost/,
  );
  assert.equal(setup.row.offset, 0);
  assert.equal(setup.calls.completes, 0);
  assert.equal(setup.calls.errors, 0);
});

test("reconciliation rejects duplicate ids and uses fresh claims", async () => {
  const duplicate = harness({ stranded: ["transfer-1", "transfer-1"] });
  await assert.rejects(() => duplicate.transfer.reconcile("tenant-1"), /duplicate/);
  const successful = harness({ stranded: ["transfer-1"] });
  assert.deepEqual(
    await successful.transfer.reconcile("tenant-1"),
    { attempted: 1, completed: 1, busy: 0, failed: 0 }
  );
});
