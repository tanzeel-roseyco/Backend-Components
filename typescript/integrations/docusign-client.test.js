const assert = require("node:assert/strict");
const { createHmac, generateKeyPairSync, verify } = require("node:crypto");
const test = require("node:test");
const {
  DocuSignClient,
  loadDocuSignConfig,
  processDocuSignWebhook,
  verifyDocuSignWebhook,
} = require("../.test-dist/integrations/docusign-client.js");

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyPair.privateKey.export({
  type: "pkcs8",
  format: "pem",
});

function config() {
  return loadDocuSignConfig({
    DOCUSIGN_USER_ID: "user",
    DOCUSIGN_ACCOUNT_ID: "account",
    DOCUSIGN_BASE_URI: "https://demo.docusign.net",
    DOCUSIGN_INTEGRATION_KEY: "integration",
    DOCUSIGN_RSA_PRIVATE_KEY: privateKey,
    DOCUSIGN_CONNECT_HMAC_SECRET: "webhook-secret",
  });
}

function idempotencyStore() {
  const reservations = new Map();
  return {
    reserve: async (scope, key, hash, create) => {
      const reservationKey = `${scope}:${key}`;
      const existing = reservations.get(reservationKey);
      if (existing) {
        if (existing.hash !== hash) throw new Error("idempotency conflict");
        return existing.result;
      }
      const result = await create();
      reservations.set(reservationKey, { hash, result });
      return result;
    },
  };
}

test("uses cached JWT auth to create and read an envelope", async () => {
  const calls = [];
  let assertion;
  const client = new DocuSignClient({
    config: config(),
    idempotencyStore: idempotencyStore(),
    now: () => 1_000_000,
    fetcher: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/oauth/token")) {
        assertion = new URLSearchParams(init.body).get("assertion");
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      if (init.method === "POST") {
        return new Response(JSON.stringify({ envelopeId: "env-1", status: "sent" }), { status: 200 });
      }
      return new Response(JSON.stringify({ envelopeId: "env-1", status: "completed" }), { status: 200 });
    },
  });
  const created = await client.createEnvelopeFromTemplate({
    templateId: "template-1",
    templateRoles: [{ roleName: "Seller", name: "Sam Seller", email: "sam@example.com" }],
    status: "sent",
    idempotencyKey: "create-env-1",
  });
  const status = await client.getEnvelopeStatus(created.envelopeId);
  assert.equal(status.status, "completed");
  assert.equal(calls.filter(({ url }) => url.includes("/oauth/token")).length, 1);
  assert.match(calls[1].init.body, /"templateId":"template-1"/);
  assert.equal(calls[1].init.headers["x-docusign-idempotency-key"], "create-env-1");
  const [header, claims, signature] = assertion.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
  assert.equal(JSON.parse(Buffer.from(claims, "base64url")).aud, "account-d.docusign.com");
  assert.equal(
    verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), keyPair.publicKey, Buffer.from(signature, "base64url")),
    true,
  );
});

test("rejects bad configuration and envelope boundaries before API calls", async () => {
  assert.throws(() => loadDocuSignConfig({
    DOCUSIGN_USER_ID: "user",
    DOCUSIGN_ACCOUNT_ID: "account",
    DOCUSIGN_BASE_URI: "http://demo.docusign.net",
    DOCUSIGN_INTEGRATION_KEY: "integration",
    DOCUSIGN_RSA_PRIVATE_KEY: privateKey,
    DOCUSIGN_CONNECT_HMAC_SECRET: "secret",
  }), /HTTPS/);
  let called = false;
  const client = new DocuSignClient({ config: config(), idempotencyStore: idempotencyStore(), fetcher: async () => {
    called = true;
    throw new Error("unexpected");
  } });
  await assert.rejects(() => client.createEnvelopeFromTemplate({
    templateId: "template",
    templateRoles: [],
    status: "sent",
    idempotencyKey: "create-env-1",
  }), /1 to 100/);
  assert.equal(called, false);
});

test("verifies completed webhooks and atomically suppresses replay", async () => {
  const rawBody = Buffer.from(JSON.stringify({
    event: "envelope-completed",
    generatedDateTime: "2026-07-24T00:00:00Z",
    data: { envelopeId: "env-1" },
  }));
  const signature = createHmac("sha256", "webhook-secret").update(rawBody).digest("base64");
  const seen = new Set();
  const store = {
    applyOnce: async (key, _envelopeId, transition) => {
      const status = transition({
        envelopeId: "env-1",
        ownerId: "seller-1",
        kind: "listing",
        status: "disclosures_signed",
      });
      if (seen.has(key)) return { applied: false, ownerId: "seller-1", status };
      seen.add(key);
      return {
        applied: true,
        ownerId: "seller-1",
        status,
      };
    },
  };
  assert.equal(verifyDocuSignWebhook(rawBody, signature, ["webhook-secret"]), true);
  const first = await processDocuSignWebhook(
    rawBody, signature, ["webhook-secret"], store,
  );
  const replay = await processDocuSignWebhook(
    rawBody, signature, ["webhook-secret"], store,
  );
  assert.deepEqual(first, { applied: true, ownerId: "seller-1", status: "fully_onboarded" });
  assert.deepEqual(replay, { applied: false, ownerId: "seller-1", status: "fully_onboarded" });
  await assert.rejects(
    () => processDocuSignWebhook(rawBody, "invalid", ["webhook-secret"], store),
    /invalid.*signature/,
  );
});

test("supports webhook key rotation and rejects oversized exact bytes", () => {
  const body = Buffer.from([0, 1, 2, 255]);
  const signature = createHmac("sha256", "new-secret").update(body).digest("base64");
  assert.equal(verifyDocuSignWebhook(body, signature, ["old-secret", "new-secret"]), true);
  assert.equal(verifyDocuSignWebhook(new Uint8Array(1_000_001), signature, ["new-secret"]), false);
});

test("coalesces token refresh, retries one 401, and recovers after token failure", async () => {
  let tokenCalls = 0;
  let apiCalls = 0;
  let failToken = true;
  const client = new DocuSignClient({
    config: config(),
    idempotencyStore: idempotencyStore(),
    fetcher: async (url) => {
      if (String(url).includes("/oauth/token")) {
        tokenCalls++;
        if (failToken) return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ access_token: `token-${tokenCalls}`, expires_in: 3600 }), { status: 200 });
      }
      apiCalls++;
      if (apiCalls === 1) return new Response("expired", { status: 401 });
      return new Response(JSON.stringify({ envelopeId: "env-1", status: "sent" }), { status: 200 });
    },
  });
  await assert.rejects(
    () => Promise.all([client.getEnvelopeStatus("env-1"), client.getEnvelopeStatus("env-2")]),
    /503/,
  );
  assert.equal(tokenCalls, 1);
  failToken = false;
  const result = await client.getEnvelopeStatus("env-1");
  assert.equal(result.status, "sent");
  assert.equal(tokenCalls, 3);
  assert.equal(apiCalls, 2);
});

test("rejects weak RSA keys, runtime status/subject, and oversized responses", async () => {
  const weakKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => loadDocuSignConfig({
    DOCUSIGN_USER_ID: "user",
    DOCUSIGN_ACCOUNT_ID: "account",
    DOCUSIGN_BASE_URI: "https://demo.docusign.net",
    DOCUSIGN_INTEGRATION_KEY: "integration",
    DOCUSIGN_RSA_PRIVATE_KEY: weakKey,
    DOCUSIGN_CONNECT_HMAC_SECRET: "secret",
  }), /2048/);
  let apiCalls = 0;
  const client = new DocuSignClient({
    config: config(),
    idempotencyStore: idempotencyStore(),
    fetcher: async (url) => {
      if (String(url).includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      apiCalls++;
      return new Response("x".repeat(1_000_001), { status: 200 });
    },
  });
  await assert.rejects(() => client.createEnvelopeFromTemplate({
    templateId: "template",
    templateRoles: [{ roleName: "Seller", name: "Sam", email: "sam@example.com" }],
    status: "invalid",
    idempotencyKey: "key",
  }), /status/);
  await assert.rejects(() => client.createEnvelopeFromTemplate({
    templateId: "template",
    templateRoles: [{ roleName: "Seller", name: "Sam", email: "sam@example.com" }],
    status: "sent",
    emailSubject: " ",
    idempotencyKey: "key",
  }), /emailSubject/);
  await assert.rejects(() => client.getEnvelopeStatus("env-1"), /size limit/);
  assert.equal(apiCalls, 1);
});

test("accepts exact regional hosts and rejects suffix-confusion hosts", () => {
  assert.equal(loadDocuSignConfig({
    DOCUSIGN_USER_ID: "user",
    DOCUSIGN_ACCOUNT_ID: "account",
    DOCUSIGN_BASE_URI: "https://eu2.docusign.net",
    DOCUSIGN_INTEGRATION_KEY: "integration",
    DOCUSIGN_RSA_PRIVATE_KEY: privateKey,
    DOCUSIGN_CONNECT_HMAC_SECRET: "secret",
  }).baseUri, "https://eu2.docusign.net");
  assert.throws(() => loadDocuSignConfig({
    DOCUSIGN_USER_ID: "user",
    DOCUSIGN_ACCOUNT_ID: "account",
    DOCUSIGN_BASE_URI: "https://demo.docusign.net.attacker.example",
    DOCUSIGN_INTEGRATION_KEY: "integration",
    DOCUSIGN_RSA_PRIVATE_KEY: privateKey,
    DOCUSIGN_CONNECT_HMAC_SECRET: "secret",
  }), /approved/);
});

test("reserves canonical account-scoped envelope requests and rejects conflicts", async () => {
  const store = idempotencyStore();
  let creates = 0;
  const client = new DocuSignClient({
    config: config(),
    idempotencyStore: store,
    fetcher: async (url) => {
      if (String(url).includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      creates++;
      return new Response(JSON.stringify({ envelopeId: "env-1", status: "sent" }), { status: 200 });
    },
  });
  const input = {
    templateId: "template",
    templateRoles: [{ roleName: "Seller", name: "Sam", email: "sam@example.com" }],
    status: "sent",
    idempotencyKey: "same-key",
  };
  assert.deepEqual(await client.createEnvelopeFromTemplate(input), await client.createEnvelopeFromTemplate(input));
  assert.equal(creates, 1);
  await assert.rejects(
    () => client.createEnvelopeFromTemplate({ ...input, templateId: "different" }),
    /idempotency conflict/,
  );
});

test("enforces deadlines when fetch and response streams ignore abort", async () => {
  const never = new Promise(() => {});
  const fetchClient = new DocuSignClient({
    config: config(),
    idempotencyStore: idempotencyStore(),
    timeoutMs: 10,
    fetcher: async () => never,
  });
  await assert.rejects(() => fetchClient.getEnvelopeStatus("env-1"), /timed out/);

  let calls = 0;
  const streamClient = new DocuSignClient({
    config: config(),
    idempotencyStore: idempotencyStore(),
    timeoutMs: 10,
    fetcher: async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      return new Response(new ReadableStream({ pull: () => never }), { status: 200 });
    },
  });
  await assert.rejects(() => streamClient.getEnvelopeStatus("env-1"), /body timed out/);
});

test("cancels void responses and validates persisted webhook ownership and results", async () => {
  let cancelled = false;
  let calls = 0;
  const client = new DocuSignClient({
    config: config(),
    idempotencyStore: idempotencyStore(),
    fetcher: async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      return new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), { status: 200 });
    },
  });
  await client.voidEnvelope("env-1", "duplicate");
  assert.equal(cancelled, true);

  const rawBody = Buffer.from(JSON.stringify({
    event: "envelope-completed",
    generatedDateTime: "2026-07-24T00:00:00Z",
    data: { envelopeId: "env-1" },
  }));
  const signature = createHmac("sha256", "webhook-secret").update(rawBody).digest("base64");
  await assert.rejects(() => processDocuSignWebhook(rawBody, signature, ["webhook-secret"], {
    applyOnce: async (_key, _envelopeId, transition) => {
      transition({ envelopeId: "other", ownerId: "seller-1", kind: "listing", status: "onboarding_initiated" });
      return { applied: true, ownerId: "seller-1", status: "listing_docs_signed" };
    },
  }), /persisted.*malformed/);
  await assert.rejects(() => processDocuSignWebhook(rawBody, signature, ["webhook-secret"], {
    applyOnce: async () => ({ applied: true, ownerId: "", status: "unknown" }),
  }), /store result.*malformed/);
});

test("validates webhook byte and rotation boundaries while evaluating every secret", () => {
  const body = Buffer.from("payload");
  const signature = createHmac("sha256", "second").update(body).digest("base64");
  assert.equal(verifyDocuSignWebhook("payload", signature, ["second"]), false);
  assert.equal(verifyDocuSignWebhook(body, signature, ["first", "second"]), true);
  assert.equal(verifyDocuSignWebhook(body, signature, ["", "second"]), false);
  assert.equal(verifyDocuSignWebhook(body, signature, ["a", "b", "c", "d", "second"]), false);
});

test("bounds configured webhook secrets by UTF-8 bytes", () => {
  assert.throws(() => loadDocuSignConfig({
    DOCUSIGN_USER_ID: "user",
    DOCUSIGN_ACCOUNT_ID: "account",
    DOCUSIGN_BASE_URI: "https://demo.docusign.net",
    DOCUSIGN_INTEGRATION_KEY: "integration",
    DOCUSIGN_RSA_PRIVATE_KEY: privateKey,
    DOCUSIGN_CONNECT_HMAC_SECRET: "é".repeat(300),
  }), /512 bytes/);
});

test("hung cancellation cannot prevent response deadlines or void completion", async () => {
  const never = new Promise(() => {});
  let calls = 0;
  const statusClient = new DocuSignClient({
    config: config(),
    idempotencyStore: idempotencyStore(),
    timeoutMs: 10,
    fetcher: async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      return new Response(new ReadableStream({
        pull: () => never,
        cancel: () => never,
      }), { status: 200 });
    },
  });
  await assert.rejects(() => statusClient.getEnvelopeStatus("env-1"), /body timed out/);

  calls = 0;
  const voidClient = new DocuSignClient({
    config: config(),
    idempotencyStore: idempotencyStore(),
    fetcher: async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      return new Response(new ReadableStream({ cancel: () => never }), { status: 200 });
    },
  });
  await voidClient.voidEnvelope("env-1", "duplicate");
});

test("rejects status responses for another envelope and mismatched persisted owners", async () => {
  let calls = 0;
  const client = new DocuSignClient({
    config: config(),
    idempotencyStore: idempotencyStore(),
    fetcher: async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ envelopeId: "env-other", status: "sent" }), { status: 200 });
    },
  });
  await assert.rejects(() => client.getEnvelopeStatus("env-requested"), /requested envelope/);

  const rawBody = Buffer.from(JSON.stringify({
    event: "envelope-completed",
    generatedDateTime: "2026-07-24T00:00:00Z",
    data: { envelopeId: "env-1" },
  }));
  const signature = createHmac("sha256", "webhook-secret").update(rawBody).digest("base64");
  await assert.rejects(() => processDocuSignWebhook(rawBody, signature, ["webhook-secret"], {
    applyOnce: async (_key, _envelopeId, transition) => {
      const status = transition({
        envelopeId: "env-1",
        ownerId: "seller-1",
        kind: "listing",
        status: "onboarding_initiated",
      });
      return { applied: true, ownerId: "seller-other", status };
    },
  }), /mismatched envelope owner/);

  await assert.rejects(() => processDocuSignWebhook(rawBody, signature, ["webhook-secret"], {
    applyOnce: async (_key, _envelopeId, transition) => {
      transition({
        envelopeId: "env-1",
        ownerId: "seller-1",
        kind: "listing",
        status: "onboarding_initiated",
      });
      return { applied: true, ownerId: "seller-1", status: "disclosures_signed" };
    },
  }), /mismatched derived status/);
});
