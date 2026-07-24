const assert = require("node:assert/strict");
const test = require("node:test");
const { SignedDocumentProcessor } = require("../.test-dist/business-logic/signed-document-processor.js");

function harness(overrides = {}) {
  const completions = new Map();
  const artifacts = new Map();
  let downloads = 0;
  let failedDocument = false;
  const provider = {
    listDocuments: async () => overrides.documents ?? [
      { documentId: "1", name: "Contract.pdf", mimeType: "application/pdf" },
      { documentId: "2", name: "Disclosure.pdf" },
    ],
    downloadDocument: async (_envelopeId, documentId, options) => {
      downloads++;
      assert.equal(options.maxBytes, 100);
      if (overrides.downloadFailure) throw new Error("download failed");
      if (overrides.failDocumentOnce === documentId && !failedDocument) {
        failedDocument = true;
        throw new Error("partial download failed");
      }
      if (overrides.neverResolve) return new Promise(() => {});
      return overrides.content ?? Buffer.from(`pdf-${documentId}`);
    },
  };
  const store = {
    getCompletion: async (key, options) => {
      assert.ok(options.signal);
      if (overrides.hangGetCompletion) return new Promise(() => {});
      return overrides.persistedResult ?? completions.get(key) ?? null;
    },
    putImmutable: async (input) => {
      assert.ok(input.signal);
      if (overrides.hangPutImmutable) return new Promise(() => {});
      if (overrides.storeFailure) throw new Error("store failed");
      const existing = artifacts.get(input.idempotencyKey);
      if (existing) return existing;
      const artifact = {
        artifactId: `artifact-${input.document.documentId}`,
        storageKey: input.idempotencyKey,
        checksumSha256: input.checksumSha256,
        sizeBytes: input.content.byteLength,
      };
      artifacts.set(input.idempotencyKey, artifact);
      return artifact;
    },
    completeOnce: async (input) => {
      assert.ok(input.signal);
      if (overrides.hangCompleteOnce) return new Promise(() => {});
      if (overrides.transitionFailure) throw new Error("transition failed");
      const existing = completions.get(input.eventKey);
      if (existing) return { ...existing, replayed: true };
      const result = overrides.completedResult ??
        { replayed: false, artifacts: input.artifacts, state: "documents_processed" };
      completions.set(input.eventKey, result);
      return result;
    },
  };
  return {
    processor: new SignedDocumentProcessor(provider, store, {
      maxDocumentBytes: 100,
      downloadTimeoutMs: overrides.timeoutMs ?? 100,
      maxTotalBytes: overrides.maxTotalBytes ?? 200,
    }),
    artifacts,
    completions,
    get downloads() { return downloads; },
  };
}

test("downloads each PDF, stores immutable artifacts, and persists actual state", async () => {
  const setup = harness();
  const result = await setup.processor.process({ envelopeId: "env-1", eventId: "event-1" });
  assert.equal(result.state, "documents_processed");
  assert.equal(result.replayed, false);
  assert.deepEqual(result.artifacts.map(({ artifactId }) => artifactId), ["artifact-1", "artifact-2"]);
  assert.equal(setup.artifacts.size, 2);
  assert.equal(setup.downloads, 2);
});

test("returns an atomically persisted replay without downloading again", async () => {
  const setup = harness();
  await setup.processor.process({ envelopeId: "env-1", eventId: "event-1" });
  const replay = await setup.processor.process({ envelopeId: "env-1", eventId: "event-1" });
  assert.equal(replay.replayed, true);
  assert.equal(setup.downloads, 2);
});

test("download and storage failures do not persist completion", async () => {
  const download = harness({ downloadFailure: true });
  await assert.rejects(
    () => download.processor.process({ envelopeId: "env-1", eventId: "event-1" }),
    /download failed/,
  );
  assert.equal(download.completions.size, 0);

  const storage = harness({ storeFailure: true });
  await assert.rejects(
    () => storage.processor.process({ envelopeId: "env-1", eventId: "event-1" }),
    /store failed/,
  );
  assert.equal(storage.completions.size, 0);
});

test("a transition failure safely reuses immutable artifacts on retry", async () => {
  const behavior = { transitionFailure: true };
  const setup = harness(behavior);
  await assert.rejects(
    () => setup.processor.process({ envelopeId: "env-1", eventId: "event-1" }),
    /transition failed/,
  );
  behavior.transitionFailure = false;
  const result = await setup.processor.process({ envelopeId: "env-1", eventId: "event-1" });
  assert.equal(result.state, "documents_processed");
  assert.equal(setup.artifacts.size, 2);
  assert.equal(setup.downloads, 4);
});

test("partial-batch retry and concurrent calls reuse immutable keys", async () => {
  const partial = harness({ failDocumentOnce: "2" });
  await assert.rejects(
    () => partial.processor.process({ envelopeId: "env-1", eventId: "event-1" }),
    /partial download failed/,
  );
  assert.equal(partial.artifacts.size, 1);
  const recovered = await partial.processor.process({ envelopeId: "env-1", eventId: "event-1" });
  assert.equal(recovered.artifacts.length, 2);
  assert.equal(partial.artifacts.size, 2);

  const concurrent = harness();
  const results = await Promise.all([
    concurrent.processor.process({ envelopeId: "env-2", eventId: "event-2" }),
    concurrent.processor.process({ envelopeId: "env-2", eventId: "event-2" }),
  ]);
  assert.equal(concurrent.artifacts.size, 2);
  assert.equal(results.filter(({ replayed }) => replayed).length, 1);
});

test("enforces real deadlines and aggregate byte bounds", async () => {
  const timeout = harness({ neverResolve: true, timeoutMs: 5 });
  await assert.rejects(
    () => timeout.processor.process({ envelopeId: "env", eventId: "event" }),
    /timed out/,
  );
  const aggregate = harness({ content: new Uint8Array(60), maxTotalBytes: 100 });
  await assert.rejects(
    () => aggregate.processor.process({ envelopeId: "env", eventId: "event" }),
    /total byte limit/,
  );
  assert.equal(aggregate.completions.size, 0);
});

test("rejects malformed persistence and empty or null boundaries", async () => {
  const malformed = harness({
    persistedResult: { replayed: false, artifacts: [{ artifactId: "x" }], state: "processed" },
  });
  await assert.rejects(
    () => malformed.processor.process({ envelopeId: "env", eventId: "event" }),
    /persisted result/,
  );
  const setup = harness();
  await assert.rejects(() => setup.processor.process(null), /input is required/);
  await assert.rejects(
    () => setup.processor.process({ envelopeId: "", eventId: "event" }),
    /envelopeId is required/,
  );
  const empty = harness({ documents: [] });
  await assert.rejects(
    () => empty.processor.process({ envelopeId: "env", eventId: "event" }),
    /documents must contain/,
  );
});

test("rejects duplicate descriptors and oversized downloads", async () => {
  const duplicate = harness({
    documents: [
      { documentId: "1", name: "One.pdf" },
      { documentId: "1", name: "Two.pdf" },
    ],
  });
  await assert.rejects(
    () => duplicate.processor.process({ envelopeId: "env", eventId: "event" }),
    /duplicate documentId/,
  );

  const oversizedSetup = harness({
    documents: [{ documentId: "1", name: "Large.pdf" }],
    content: new Uint8Array(101),
  });
  await assert.rejects(
    () => oversizedSetup.processor.process({ envelopeId: "env", eventId: "event" }),
    /size bounds/,
  );
});

test("hard deadlines reject stores that ignore abort at every persistence stage", async () => {
  for (const option of ["hangGetCompletion", "hangPutImmutable", "hangCompleteOnce"]) {
    const setup = harness({ [option]: true, timeoutMs: 5 });
    await assert.rejects(
      () => setup.processor.process({ envelopeId: "env", eventId: "event" }),
      /timed out/,
    );
  }
});

test("rejects non-boolean replay flags from lookup and atomic completion", async () => {
  const malformedReplay = harness({
    persistedResult: {
      replayed: "yes",
      artifacts: [{
        artifactId: "artifact-1",
        storageKey: `signed-document-artifact:v1:${"a".repeat(64)}`,
        checksumSha256: "b".repeat(64),
        sizeBytes: 1,
      }],
      state: "documents_processed",
    },
  });
  await assert.rejects(
    () => malformedReplay.processor.process({ envelopeId: "env", eventId: "event" }),
    /persisted result/,
  );

  const malformedCompletion = harness({
    completedResult: {
      replayed: "no",
      artifacts: [],
      state: "documents_processed",
    },
  });
  await assert.rejects(
    () => malformedCompletion.processor.process({ envelopeId: "env", eventId: "event" }),
    /persisted result/,
  );
});
