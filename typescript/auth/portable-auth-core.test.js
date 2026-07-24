const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const test = require("node:test");
const {
  JwksJwtVerifier,
  claimInvite,
  consumePkceTransaction,
  issueInvite,
  startPkceTransaction,
} = require("../.test-dist/auth/portable-auth-core.js");

const nowMs = 2_000_000_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = pair.publicKey.export({ format: "jwk" });
Object.assign(jwk, { kid: "key-1", alg: "RS256", use: "sig" });

function jwt(claims = {}, header = {}, signingKey = pair.privateKey) {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1", ...header })).toString("base64url");
  const encodedClaims = Buffer.from(JSON.stringify({
    iss: "https://issuer.example",
    aud: "client-1",
    exp: Math.floor(nowMs / 1000) + 300,
    iat: Math.floor(nowMs / 1000),
    ...claims,
  })).toString("base64url");
  const input = `${encodedHeader}.${encodedClaims}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), signingKey).toString("base64url")}`;
}

function verifier(keys = [jwk]) {
  let calls = 0;
  return {
    instance: new JwksJwtVerifier({
      jwksUrl: "https://issuer.example/jwks",
      issuers: ["https://issuer.example"],
      audience: "client-1",
      now: () => nowMs,
      fetcher: {
        fetch: async (_url, options) => {
          calls++;
          assert.ok(options.signal);
          return new Response(JSON.stringify({ keys }), { status: 200 });
        },
      },
    }),
    get calls() { return calls; },
  };
}

test("creates and consumes one high-entropy PKCE transaction", async () => {
  const records = new Map();
  const store = {
    create: async (record) => records.set(record.stateHash, record),
    consume: async (hash, current) => {
      const record = records.get(hash);
      if (!record || record.expiresAt <= current) return null;
      records.delete(hash);
      return record;
    },
  };
  const started = await startPkceTransaction(store, "http://127.0.0.1:4123/callback", { now: () => nowMs });
  assert.equal(started.state.length, 43);
  assert.equal(started.verifier.length, 43);
  assert.equal(started.method, "S256");
  assert.equal(started.redirectUri, "http://127.0.0.1:4123/callback");
  const consumed = await consumePkceTransaction(store, started.state, () => nowMs);
  assert.equal(consumed.verifier, started.verifier);
  await assert.rejects(() => consumePkceTransaction(store, started.state, () => nowMs), /already consumed/);
});

test("rejects weak or malformed RSA JWKS parameters", async () => {
  const weak = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" });
  Object.assign(weak, { kid: "key-1", alg: "RS256", use: "sig" });
  await assert.rejects(() => verifier([weak]).instance.verify(jwt()), /2048 bits/);
  const badExponent = { ...jwk, e: Buffer.from([2]).toString("base64url") };
  await assert.rejects(() => verifier([badExponent]).instance.verify(jwt()), /exponent/);
  const nonCanonical = { ...jwk, n: `${jwk.n}=` };
  await assert.rejects(() => verifier([nonCanonical]).instance.verify(jwt()), /canonical base64url/);
});

test("coalesces JWKS fetches, cools unknown kids, and refreshes one rotated same-kid key", async () => {
  const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rotatedJwk = rotated.publicKey.export({ format: "jwk" });
  Object.assign(rotatedJwk, { kid: "key-1", alg: "RS256", use: "sig", key_ops: ["verify"] });
  let calls = 0;
  let keys = [jwk];
  const instance = new JwksJwtVerifier({
    jwksUrl: "https://issuer.example/jwks",
    issuers: ["https://issuer.example"],
    audience: "client-1",
    now: () => nowMs,
    refreshCooldownMs: 60_000,
    fetcher: { fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ keys }), { status: 200 });
    } },
  });
  await Promise.all([instance.verify(jwt()), instance.verify(jwt())]);
  assert.equal(calls, 1);
  await assert.rejects(() => instance.verify(jwt({}, { kid: "unknown" })), /kid/);
  await assert.rejects(() => instance.verify(jwt({}, { kid: "unknown" })), /kid/);
  assert.equal(calls, 2);
  keys = [rotatedJwk];
  const rotatedToken = jwt({}, {}, rotated.privateKey);
  assert.equal((await instance.verify(rotatedToken)).claims.iss, "https://issuer.example");
  assert.equal(calls, 3);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(() => instance.verify(jwt({}, {}, other.privateKey)), /signature/);
  assert.equal(calls, 3);
});

test("distinct unknown kids share one bounded forced-refresh cooldown", async () => {
  let calls = 0;
  const instance = new JwksJwtVerifier({
    jwksUrl: "https://issuer.example/jwks",
    issuers: ["https://issuer.example"],
    audience: "client-1",
    now: () => nowMs,
    refreshCooldownMs: 60_000,
    fetcher: { fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    } },
  });
  await instance.verify(jwt());
  const attempts = await Promise.allSettled(
    Array.from({ length: 500 }, (_, index) =>
      instance.verify(jwt({}, { kid: `attacker-kid-${index}` }))),
  );
  assert.equal(attempts.every(({ status }) => status === "rejected"), true);
  assert.equal(calls, 2);
  assert.equal(Object.hasOwn(instance, "refreshBlockedUntil"), false);
});

test("enforces a rejecting JWKS deadline when the adapter ignores abort", async () => {
  const instance = new JwksJwtVerifier({
    jwksUrl: "https://issuer.example/jwks",
    issuers: ["https://issuer.example"],
    audience: "client-1",
    now: () => nowMs,
    fetchTimeoutMs: 5,
    fetcher: { fetch: async () => new Promise(() => {}) },
  });
  await assert.rejects(() => instance.verify(jwt()), /timed out/);
  const stalledBody = new JwksJwtVerifier({
    jwksUrl: "https://issuer.example/jwks",
    issuers: ["https://issuer.example"],
    audience: "client-1",
    now: () => nowMs,
    fetchTimeoutMs: 5,
    fetcher: { fetch: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }) },
  });
  await assert.rejects(() => stalledBody.verify(jwt()), /timed out/);
});

test("rejects oversized streamed JWKS and non-literal HTTP loopback redirects", async () => {
  const instance = new JwksJwtVerifier({
    jwksUrl: "https://issuer.example/jwks",
    issuers: ["https://issuer.example"],
    audience: "client-1",
    now: () => nowMs,
    maxJwksBytes: 10,
    fetcher: { fetch: async () => new Response("x".repeat(11), { status: 200 }) },
  });
  await assert.rejects(() => instance.verify(jwt()), /size limit/);
  await assert.rejects(
    () => startPkceTransaction({ create: async () => {}, consume: async () => null }, "http://localhost/callback"),
    /loopback/,
  );
});

test("verifies RS256 JWT claims and caches bounded JWKS", async () => {
  const setup = verifier();
  const first = await setup.instance.verify(jwt({ sub: "user-1" }));
  await setup.instance.verify(jwt({ sub: "user-2" }));
  assert.equal(first.claims.sub, "user-1");
  assert.equal(setup.calls, 1);
});

test("rejects bad JWT algorithm, kid, issuer, expiry, and signature", async () => {
  const setup = verifier();
  await assert.rejects(() => setup.instance.verify(jwt({}, { alg: "HS256" })), /algorithm/);
  await assert.rejects(() => setup.instance.verify(jwt({}, { kid: "missing" })), /kid was not found/);
  await assert.rejects(() => setup.instance.verify(jwt({ iss: "https://evil.example" })), /issuer/);
  await assert.rejects(() => setup.instance.verify(jwt({ exp: Math.floor(nowMs / 1000) - 61 })), /expired/);
  await assert.rejects(() => setup.instance.verify(jwt({ iat: Math.floor(nowMs / 1000) + 61 })), /issued-at/);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(() => setup.instance.verify(jwt({}, {}, other.privateKey)), /signature/);
});

test("hashes an invite and permits exactly one unexpired claim", async () => {
  const records = new Map();
  const store = {
    create: async (record) => {
      assert.equal(record.tokenHash.length, 64);
      records.set(record.tokenHash, record);
    },
    consume: async (hash, current) => {
      const record = records.get(hash);
      if (!record || record.expiresAt <= current) return null;
      records.delete(hash);
      return record.claim;
    },
  };
  const token = await issueInvite(store, { email: "person@example.com" }, { now: () => nowMs, ttlMs: 60_000 });
  assert.deepEqual(await claimInvite(store, token, () => nowMs), { email: "person@example.com" });
  await assert.rejects(() => claimInvite(store, token, () => nowMs), /already claimed/);

  const expired = await issueInvite(store, { email: "late@example.com" }, { now: () => nowMs, ttlMs: 60_000 });
  await assert.rejects(() => claimInvite(store, expired, () => nowMs + 60_000), /expired/);
  await assert.rejects(() => issueInvite(store, null, { now: () => nowMs }), /claim is required/);
});
