const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const test = require("node:test");
const {
  buildConferenceJoinTwiml,
  handleTwoLegConferenceEvent,
  reconstructPublicUrl,
  verifyTwilioSignature,
} = require("../.test-dist/integrations/twilio-voice.js");

test("reconstructs a public URL and verifies a Twilio form signature", () => {
  const url = reconstructPublicUrl({
    requestUrl: "/voice?tenant=7",
    publicBaseUrl: "https://calls.example.test",
  });
  const params = { CallSid: "CA123", Digits: "7" };
  const payload = url + "CallSidCA123Digits7";
  const signature = createHmac("sha1", "secret").update(payload).digest("base64");
  assert.equal(url, "https://calls.example.test/voice?tenant=7");
  assert.equal(verifyTwilioSignature({ authToken: "secret", signature, url, params }), true);
  assert.equal(verifyTwilioSignature({ authToken: "secret", signature: "wrong", url, params }), false);
});

test("rejects unsafe public URLs and malformed signature inputs", () => {
  assert.throws(() => reconstructPublicUrl({ requestUrl: "/", publicBaseUrl: "file:///tmp" }), /HTTP/);
  assert.throws(
    () => reconstructPublicUrl({ requestUrl: "https://evil.example/voice", publicBaseUrl: "https://calls.example.test" }),
    /path and query/,
  );
  assert.throws(
    () => reconstructPublicUrl({ requestUrl: "/voice#fragment", publicBaseUrl: "https://calls.example.test" }),
    /path and query/,
  );
  assert.throws(
    () => reconstructPublicUrl({ requestUrl: "/", publicBaseUrl: "https://user:pass@calls.example.test" }),
    /credentials/,
  );
  assert.throws(() => verifyTwilioSignature({ authToken: "", signature: "x", url: "https://example.test" }), /authToken/);
  assert.throws(() => verifyTwilioSignature({ authToken: " ", signature: "x", url: "https://example.test" }), /authToken/);
  assert.equal(
    verifyTwilioSignature({
      authToken: "secret",
      signature: "!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      url: "https://example.test/",
    }),
    false,
  );
});

test("escapes conference names and rejects invalid names", () => {
  const twiml = buildConferenceJoinTwiml({ conferenceName: `Sales & "Support"`, endConferenceOnExit: true });
  assert.match(twiml, /Sales &amp; &quot;Support&quot;/);
  assert.match(twiml, /endConferenceOnExit="true"/);
  assert.throws(() => buildConferenceJoinTwiml({ conferenceName: " " }), /required/);
  assert.doesNotThrow(() => buildConferenceJoinTwiml({ conferenceName: "x".repeat(128) }));
  assert.throws(() => buildConferenceJoinTwiml({ conferenceName: "x".repeat(129) }), /128/);
  assert.throws(() => buildConferenceJoinTwiml({ conferenceName: "bad\u0000name" }), /XML 1.0/);
});

test("bounds signature inputs at the webhook trust boundary", () => {
  const validSignature = "AAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  assert.throws(
    () => verifyTwilioSignature({
      authToken: "secret",
      signature: validSignature,
      url: `https://example.test/${"x".repeat(2050)}`,
    }),
    /2048 bytes/,
  );
  assert.throws(
    () => verifyTwilioSignature({
      authToken: "secret",
      signature: validSignature,
      url: "https://example.test/",
      params: { key: "x".repeat(4001) },
    }),
    /4000 bytes/,
  );
});

test("orchestrates both conference legs through explicit forward states", async () => {
  const requests = [];
  const dependencies = {
    createCall: async (request) => {
      requests.push(request);
      return { callSid: request.leg === "first" ? "CA-first" : "CA-second" };
    },
  };
  let state = {
    id: "job-1",
    conferenceName: "room-1",
    firstNumber: "+61000000001",
    secondNumber: "+61000000002",
    state: "pending",
  };
  state = await handleTwoLegConferenceEvent(state, { type: "start" }, dependencies);
  state = await handleTwoLegConferenceEvent(state, { type: "first_answered", callSid: "CA-first" }, dependencies);
  state = await handleTwoLegConferenceEvent(state, { type: "second_answered", callSid: "CA-second" }, dependencies);
  assert.equal(state.state, "connected");
  assert.deepEqual(requests.map(({ leg }) => leg), ["first", "second"]);
  assert.deepEqual(requests.map(({ idempotencyKey }) => idempotencyKey), ["job-1:first", "job-1:second"]);
});

test("replayed starts use one provider idempotency key", async () => {
  const keys = [];
  const base = {
    id: "job-replay",
    conferenceName: "room-1",
    firstNumber: "+61000000001",
    secondNumber: "+61000000002",
    state: "pending",
  };
  const dependencies = {
    createCall: async ({ idempotencyKey }) => {
      keys.push(idempotencyKey);
      return { callSid: "CA-same-provider-call" };
    },
  };
  const first = await handleTwoLegConferenceEvent(base, { type: "start" }, dependencies);
  const replay = await handleTwoLegConferenceEvent(base, { type: "start" }, dependencies);
  assert.deepEqual(keys, ["job-replay:first", "job-replay:first"]);
  assert.equal(first.firstCallSid, replay.firstCallSid);
});

test("propagates call creation failures without mutating input state", async () => {
  const base = {
    id: "job-1",
    conferenceName: "room-1",
    firstNumber: "+61000000001",
    secondNumber: "+61000000002",
    state: "pending",
  };
  await assert.rejects(
    () => handleTwoLegConferenceEvent(base, { type: "start" }, {
      createCall: async () => { throw new Error("provider unavailable"); },
    }),
    /provider unavailable/,
  );
  assert.equal(base.state, "pending");
});

test("rejects out-of-order and mismatched callbacks and records pre-connect failures", async () => {
  const base = {
    id: "job-1",
    conferenceName: "room-1",
    firstNumber: "+61000000001",
    secondNumber: "+61000000002",
    state: "pending",
  };
  const dependencies = { createCall: async () => ({ callSid: "CA-first" }) };
  await assert.rejects(
    () => handleTwoLegConferenceEvent(base, { type: "second_answered", callSid: "CA-x" }, dependencies),
    /invalid from pending/,
  );
  const dialing = await handleTwoLegConferenceEvent(base, { type: "start" }, dependencies);
  await assert.rejects(
    () => handleTwoLegConferenceEvent(dialing, { type: "first_answered", callSid: "CA-wrong" }, dependencies),
    /does not match/,
  );
  const failed = await handleTwoLegConferenceEvent(
    dialing,
    { type: "leg_failed", leg: "first", callSid: "CA-first", reason: "busy" },
    dependencies,
  );
  assert.equal(failed.state, "failed");
  await assert.rejects(() => handleTwoLegConferenceEvent(failed, { type: "start" }, dependencies), /invalid from failed/);
});

test("rejects stale failure callbacks and impossible state snapshots", async () => {
  const dependencies = { createCall: async () => ({ callSid: "CA-second" }) };
  const secondDialing = {
    id: "job-1",
    conferenceName: "room-1",
    firstNumber: "+61000000001",
    secondNumber: "+61000000002",
    state: "second_leg_dialing",
    firstCallSid: "CA-first",
    secondCallSid: "CA-second",
  };
  await assert.rejects(
    () => handleTwoLegConferenceEvent(
      secondDialing,
      { type: "leg_failed", leg: "first", callSid: "CA-first", reason: "late callback" },
      dependencies,
    ),
    /does not match the active call/,
  );
  await assert.rejects(
    () => handleTwoLegConferenceEvent(
      { ...secondDialing, secondCallSid: undefined },
      { type: "second_answered", callSid: "CA-second" },
      dependencies,
    ),
    /snapshot is invalid/,
  );
  await assert.rejects(
    () => handleTwoLegConferenceEvent(
      {
        id: "job-1", conferenceName: "room-1", firstNumber: "+61000000001",
        secondNumber: "+61000000002", state: "failed",
      },
      { type: "start" },
      dependencies,
    ),
    /snapshot is invalid/,
  );
  await assert.rejects(
    () => handleTwoLegConferenceEvent(
      { ...secondDialing, state: "connected", failureReason: "stale failure" },
      { type: "start" },
      dependencies,
    ),
    /snapshot is invalid/,
  );
});
