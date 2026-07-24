const assert = require("node:assert/strict");
const test = require("node:test");
const { DotloopClient } = require("../.test-dist/integrations/dotloop-client.js");

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, statusText: status === 200 ? "OK" : "Failure" });

test("builds PKCE authorization and performs refresh-backed loop operations", async () => {
  const calls = [];
  const rotations = [];
  const client = new DotloopClient({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    onRefreshToken: (token) => rotations.push(token),
    now: () => 1_000,
    fetcher: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/oauth/token")) {
        return json({ access_token: "access", refresh_token: "rotated", expires_in: 3600 });
      }
      if (String(url).endsWith("/loop")) {
        return json({ data: { id: 7, name: "Buyer Loop", loopUrl: "https://loop/7" } });
      }
      if (String(url).endsWith("/participant")) return json({ data: { id: 8 } });
      if (String(url).endsWith("/detail")) return json({ data: { ok: true } });
      return json({ data: [{ id: 9, name: "Template" }] });
    },
  });

  const transaction = await client.createAuthorizationTransaction({
    redirectUri: "https://app.example.test/callback",
    scope: ["account:read", "account:read", "loop:write"],
  });
  const auth = new URL(transaction.authorizationUrl);
  assert.equal(auth.searchParams.get("state"), transaction.state);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("scope"), "account:read loop:write");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(transaction.codeVerifier))
  );
  const expectedChallenge = Buffer.from(digest).toString("base64url");
  assert.equal(auth.searchParams.get("code_challenge"), expectedChallenge);

  const exchanged = await client.exchangeAuthorizationCallback({
    code: "code",
    state: transaction.state,
    redirectUri: "https://app.example.test/callback",
  });
  assert.deepEqual(exchanged, { accessToken: "access", refreshToken: "rotated" });
  assert.equal(client.getRefreshToken(), "rotated");
  assert.deepEqual(rotations, ["rotated"]);
  await assert.rejects(
    () => client.exchangeAuthorizationCallback({
      code: "code", state: transaction.state, redirectUri: transaction.redirectUri,
    }),
    /consumed/
  );

  const loop = await client.createLoop(12, { name: "Buyer Loop" });
  await client.getLoopTemplates(12);
  await client.addParticipant(12, 7, { fullName: "A Buyer", role: "BUYER", phone: "555" });
  await client.updateLoopDetails(12, 7, { propertyAddress: { city: "KC" } });
  assert.equal(loop.id, 7);
  assert.equal(calls.filter((call) => call.url.includes("/oauth/token")).length, 1);
  assert.match(calls.find((call) => call.url.endsWith("/loop")).init.body, /Buyer Loop/);
  assert.match(calls.find((call) => call.url.endsWith("/participant")).init.body, /"Phone":"555"/);
  assert.deepEqual(
    JSON.parse(calls.find((call) => call.url.endsWith("/detail")).init.body),
    { propertyAddress: { city: "KC" } }
  );
});

test("rejects unsafe boundaries before network access", async () => {
  assert.throws(
    () => new DotloopClient({ clientId: "id", clientSecret: "secret", apiUrl: "file:///tmp/api" }),
    /HTTP|HTTPS/
  );
  assert.throws(
    () => new DotloopClient({ clientId: "id", clientSecret: "secret", apiUrl: "https://evil.example/v2" }),
    /allowed/
  );
  assert.doesNotThrow(() => new DotloopClient({
    clientId: "id",
    clientSecret: "secret",
    apiUrl: "https://dotloop.test/v2",
    allowedOrigins: ["https://dotloop.test"],
  }));
  let called = false;
  const client = new DotloopClient({
    clientId: "id",
    clientSecret: "secret",
    fetcher: async () => { called = true; return json({}); },
  });
  await assert.rejects(() => client.createLoop(0, { name: "x" }), /profileId/);
  await assert.rejects(() => client.updateLoopDetails(1, 2, {}), /non-empty/);
  assert.equal(called, false);
});

test("bounds provider errors and retries one unauthorized API request", async () => {
  let tokenCalls = 0;
  let apiCalls = 0;
  const client = new DotloopClient({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetcher: async (url) => {
      if (String(url).includes("/oauth/token")) {
        tokenCalls++;
        return json({ access_token: `access-${tokenCalls}`, expires_in: 3600 });
      }
      apiCalls++;
      if (apiCalls === 1) return new Response("expired", { status: 401 });
      return new Response("x".repeat(2_000), { status: 500 });
    },
  });
  await assert.rejects(
    () => client.getProfiles(),
    (error) => error.message.length < 600 && /500/.test(error.message)
  );
  assert.equal(tokenCalls, 2);
  assert.equal(apiCalls, 2);
});

test("rejects on deadline when fetch ignores abort", async () => {
  const client = new DotloopClient({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
    timeoutMs: 5,
    fetcher: async () => new Promise(() => {}),
  });
  await assert.rejects(() => client.refresh(), /request timed out/);
});

test("rejects and cancels when a response stream stalls", async () => {
  let cancelled = false;
  const client = new DotloopClient({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
    timeoutMs: 5,
    fetcher: async () =>
      new Response(new ReadableStream({
        pull: async () => new Promise(() => {}),
        cancel: () => { cancelled = true; },
      })),
  });
  await assert.rejects(() => client.refresh(), /response read timed out/);
  await Promise.resolve();
  assert.equal(cancelled, true);
});

test("isolates concurrent clients by refresh token", async () => {
  const bodies = [];
  const fetcher = async (url, init) => {
    if (String(url).includes("/oauth/token")) {
      const token = init.body.get("refresh_token");
      bodies.push(token);
      await Promise.resolve();
      return json({ access_token: `access-${token}`, expires_in: 3600 });
    }
    return json({ data: [] });
  };
  const first = new DotloopClient({
    clientId: "id", clientSecret: "secret", refreshToken: "one", fetcher,
  });
  const second = new DotloopClient({
    clientId: "id", clientSecret: "secret", refreshToken: "two", fetcher,
  });
  await Promise.all([first.getProfiles(), second.getProfiles()]);
  assert.deepEqual(bodies.sort(), ["one", "two"]);
});

test("rejects callback mismatch, oversized responses, and malformed loops", async () => {
  const mismatch = new DotloopClient({ clientId: "id", clientSecret: "secret" });
  const transaction = await mismatch.createAuthorizationTransaction({
    redirectUri: "https://app.example.test/callback?return=%2F",
  });
  await assert.rejects(
    () => mismatch.exchangeAuthorizationCallback({
      code: "code",
      state: transaction.state,
      redirectUri: "https://app.example.test/callback?return=/",
    }),
    /does not match/
  );

  const oversized = new DotloopClient({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetcher: async (url) =>
      String(url).includes("/oauth/token")
        ? json({ access_token: "access", expires_in: 3600 })
        : new Response("x".repeat(1_000_001)),
  });
  await assert.rejects(() => oversized.getProfiles(), /size limit/);

  const malformed = new DotloopClient({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetcher: async (url) =>
      String(url).includes("/oauth/token")
        ? json({ access_token: "access", expires_in: 3600 })
        : json({ data: { id: 0, name: 2 } }),
  });
  await assert.rejects(() => malformed.createLoop(1, { name: "Loop" }), /malformed/);
});

test("does not activate a token when refresh rotation persistence fails", async () => {
  let tokenCalls = 0;
  const client = new DotloopClient({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "old",
    onRefreshToken: async () => { throw new Error("persistence down"); },
    fetcher: async (url) => {
      if (String(url).includes("/oauth/token")) {
        tokenCalls++;
        return json({ access_token: "access", refresh_token: "new", expires_in: 3600 });
      }
      return json({ data: [] });
    },
  });
  await assert.rejects(() => client.getProfiles(), /persistence down/);
  await assert.rejects(() => client.getProfiles(), /persistence down/);
  assert.equal(tokenCalls, 2);
  assert.equal(client.getRefreshToken(), "old");
});

test("expires pending authorization state and enforces bounded capacity", async () => {
  let now = 1_000;
  const client = new DotloopClient({
    clientId: "id",
    clientSecret: "secret",
    now: () => now,
    authorizationTtlMs: 100,
    maxPendingAuthorizations: 2,
  });
  const first = await client.createAuthorizationTransaction({
    redirectUri: "https://app.example.test/callback",
  });
  await client.createAuthorizationTransaction({
    redirectUri: "https://app.example.test/callback",
  });
  await assert.rejects(
    () => client.createAuthorizationTransaction({
      redirectUri: "https://app.example.test/callback",
    }),
    /too many pending/
  );
  now += 100;
  await assert.rejects(
    () => client.exchangeAuthorizationCallback({
      code: "code",
      state: first.state,
      redirectUri: first.redirectUri,
    }),
    /invalid or already consumed/
  );
  await assert.doesNotReject(() => client.createAuthorizationTransaction({
    redirectUri: "https://app.example.test/callback",
  }));
});

test("coalesces concurrent unauthorized responses onto one replacement token", async () => {
  let tokenCalls = 0;
  let oldTokenCalls = 0;
  let releaseDelayedUnauthorized;
  const replacementReady = new Promise((resolve) => { releaseDelayedUnauthorized = resolve; });
  const client = new DotloopClient({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetcher: async (url, init) => {
      if (String(url).includes("/oauth/token")) {
        tokenCalls++;
        if (tokenCalls === 2) releaseDelayedUnauthorized();
        return json({ access_token: `access-${tokenCalls}`, expires_in: 3600 });
      }
      if (init.headers.authorization === "Bearer access-1") {
        oldTokenCalls++;
        if (oldTokenCalls === 2) await replacementReady;
        return new Response("expired", { status: 401 });
      }
      assert.equal(init.headers.authorization, "Bearer access-2");
      return json({ data: [] });
    },
  });
  await Promise.all([client.getProfiles(), client.getProfiles()]);
  assert.equal(tokenCalls, 2);
  assert.equal(oldTokenCalls, 2);
});
