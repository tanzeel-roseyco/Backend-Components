const assert = require("node:assert/strict");
const test = require("node:test");
const {
  TelegramIntakeError,
  intakeTelegramWebhook,
} = require("../.test-dist/integrations/telegram-intake.js");

const secret = "telegram_secret";
const baseMessage = {
  message_id: 7,
  date: 1_700_000_000,
  chat: { id: -100_123 },
  from: { id: 200 },
};

class DurableFakeStore {
  constructor() {
    this.rows = new Map();
    this.transaction = Promise.resolve();
  }

  insertOrRead(input, signal) {
    const operation = this.transaction.then(async () => {
      await Promise.resolve();
      if (signal.aborted) throw new Error("aborted");
      const key = `${input.botId}\0${input.integrationId}\0${input.updateId}`;
      const existing = this.rows.get(key);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          throw new Error("update id reused with different fingerprint");
        }
        return { created: false, record: existing };
      }
      const persisted = structuredClone(input);
      this.rows.set(key, persisted);
      return { created: true, record: persisted };
    });
    this.transaction = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

function harness(store = new DurableFakeStore()) {
  const options = {
    botId: "proposal_bot",
    integrationId: "primary",
    secretToken: secret,
    allowedChatIds: [-100_123],
    allowedUserIds: [200],
    store,
  };
  const request = (body, suppliedSecret = secret, signal) => new Request(
    "https://bot.example/telegram",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": suppliedSecret,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal,
    }
  );
  return { options, request, store };
}

test("accepts bounded text commands and positive-sized document descriptors", async () => {
  const { options, request, store } = harness();
  const text = await intakeTelegramWebhook(request({
    update_id: 1,
    message: { ...baseMessage, text: "/Proposal@My_Bot   client brief" },
  }), options);
  assert.deepEqual(text.update.command, {
    name: "proposal",
    botUsername: "my_bot",
    arguments: "client brief",
  });

  const document = await intakeTelegramWebhook(request({
    update_id: 2,
    message: {
      ...baseMessage,
      document: {
        file_id: "telegram-file-token",
        file_unique_id: "stable-file-token",
        file_name: "brief.pdf",
        mime_type: "application/pdf",
        file_size: 1234,
      },
    },
  }), options);
  assert.equal(document.update.document.fileSize, 1234);
  const withoutSize = await intakeTelegramWebhook(request({
    update_id: 3,
    message: {
      ...baseMessage,
      document: {
        file_id: "telegram-file-without-size",
        file_unique_id: "stable-file-without-size",
      },
    },
  }), options);
  assert.equal(withoutSize.update.document.fileSize, undefined);
  assert.equal(store.rows.size, 3);
});

test("rejects secrets, exact byte overflow, malformed, ambiguous, and unauthorized updates", async () => {
  const { options, request } = harness();
  await assert.rejects(
    () => intakeTelegramWebhook(request({ update_id: 1, message: baseMessage }, "wrong"), options),
    (error) => error instanceof TelegramIntakeError && error.status === 401
  );
  await assert.rejects(
    () => intakeTelegramWebhook(request("x".repeat(101)), { ...options, maxJsonBytes: 100 }),
    (error) => error.status === 413
  );
  await assert.rejects(
    () => intakeTelegramWebhook(request({
      update_id: 1,
      message: {
        ...baseMessage,
        text: "ambiguous",
        document: { file_id: "a", file_unique_id: "b", file_size: 1 },
      },
    }), options),
    /both text and document/
  );
  for (const body of [
    { update_id: 0, message: { ...baseMessage, text: "bad update" } },
    { update_id: 1, message: { ...baseMessage, date: 0, text: "bad date" } },
    {
      update_id: 1,
      message: {
        ...baseMessage,
        document: { file_id: "a", file_unique_id: "b", file_size: 0 },
      },
    },
    { update_id: 1, message: { ...baseMessage, from: { id: 999 }, text: "unauthorized" } },
  ]) {
    await assert.rejects(() => intakeTelegramWebhook(request(body), options));
  }
});

test("accepts JSON parameters but rejects lookalike media types", async () => {
  const { options } = harness();
  const body = JSON.stringify({
    update_id: 90,
    message: { ...baseMessage, text: "hello" },
  });
  const make = (contentType) => new Request("https://bot.example/telegram", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-telegram-bot-api-secret-token": secret,
    },
    body,
  });
  assert.equal(
    (await intakeTelegramWebhook(make("application/json; charset=utf-8"), options)).accepted,
    true
  );
  for (const contentType of ["application/jsonp", "application/json-evil"]) {
    await assert.rejects(
      () => intakeTelegramWebhook(make(contentType), options),
      (error) => error.status === 415
    );
  }
});

test("durable atomic replay is namespaced and rejects update-id fingerprint conflicts", async () => {
  const { options, request, store } = harness();
  const body = { update_id: 42, message: { ...baseMessage, text: "/start" } };
  const [first, second] = await Promise.all([
    intakeTelegramWebhook(request(body), options),
    intakeTelegramWebhook(request(body), options),
  ]);
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);

  await assert.rejects(
    () => intakeTelegramWebhook(request({
      update_id: 42,
      message: { ...baseMessage, text: "different payload" },
    }), options),
    /different fingerprint/
  );
  const otherBot = await intakeTelegramWebhook(
    request({ update_id: 42, message: { ...baseMessage, text: "other bot" } }),
    { ...options, botId: "support_bot" }
  );
  assert.equal(otherBot.accepted, true);
  assert.equal(store.rows.size, 2);
});

test("one deadline bounds a stalled store and caller abort", async () => {
  const stalled = {
    insertOrRead: async () => new Promise(() => {}),
  };
  const first = harness(stalled);
  await assert.rejects(
    () => intakeTelegramWebhook(
      first.request({ update_id: 1, message: { ...baseMessage, text: "hello" } }),
      { ...first.options, timeoutMs: 5 }
    ),
    (error) => error.status === 408
  );

  const controller = new AbortController();
  controller.abort();
  let storeCalls = 0;
  const second = harness({
    insertOrRead: async () => {
      storeCalls++;
      throw new Error("store must not be called");
    },
  });
  await assert.rejects(
    () => intakeTelegramWebhook(
      second.request(
        { update_id: 2, message: { ...baseMessage, text: "hello" } },
        secret,
        controller.signal
      ),
      second.options
    ),
    (error) => error.status === 408
  );
  assert.equal(storeCalls, 0);
});

test("oversized input rejects without awaiting a hung stream cancellation", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"update_id":123456789}'));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  const { options } = harness();
  const request = new Request("https://bot.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body,
    duplex: "half",
  });
  await assert.rejects(
    () => intakeTelegramWebhook(request, { ...options, maxJsonBytes: 10 }),
    (error) => error.status === 413
  );
  assert.equal(cancelled, true);
});
