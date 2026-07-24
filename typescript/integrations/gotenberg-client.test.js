const assert = require("node:assert/strict");
const test = require("node:test");
const { GotenbergClient } = require("../.test-dist/integrations/gotenberg-client.js");

test("renders HTML through the Chromium form endpoint", async () => {
  let request;
  const client = new GotenbergClient({
    baseUrl: "https://pdf.example.test/",
    fetcher: async (url, init) => {
      request = { url, init };
      return new Response(new TextEncoder().encode("%PDF-1.4\n%%EOF"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    },
  });
  const pdf = await client.renderHtml("<h1>Hello</h1>", { marginTop: "1in" });
  assert.equal(new TextDecoder().decode(pdf), "%PDF-1.4\n%%EOF");
  assert.equal(request.url, "https://pdf.example.test/forms/chromium/convert/html");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.body.get("marginTop"), "1in");
  assert.equal(await request.init.body.get("files").text(), "<h1>Hello</h1>");
});

test("rejects empty HTML and surfaces bounded provider errors", async () => {
  const client = new GotenbergClient({
    baseUrl: "https://pdf.example.test",
    fetcher: async () => new Response("bad request", { status: 400 }),
  });
  await assert.rejects(() => client.renderHtml(" "), /html is required/);
  await assert.rejects(() => client.renderHtml("<p>x</p>"), /400.*bad request/);
});

test("rejects unsafe protocols and invalid timeouts", () => {
  assert.throws(() => new GotenbergClient({ baseUrl: "file:///tmp/pdf" }));
  assert.throws(() => new GotenbergClient({ baseUrl: "https://pdf.example.test?token=x" }));
  assert.throws(() => new GotenbergClient({ baseUrl: "https://user:pass@pdf.example.test" }), /credentials/);
  assert.throws(() => new GotenbergClient({ baseUrl: "https://pdf.example.test", timeoutMs: 0 }));
  assert.throws(() => new GotenbergClient({
    baseUrl: "https://pdf.example.test",
    maxHtmlBytes: 10 * 1024 * 1024 + 1,
  }), /maxHtmlBytes/);
  assert.throws(() => new GotenbergClient({
    baseUrl: "https://pdf.example.test",
    maxPdfBytes: 100 * 1024 * 1024 + 1,
  }), /maxPdfBytes/);
});

test("enforces HTML and render-option limits", async () => {
  const client = new GotenbergClient({ baseUrl: "https://pdf.example.test", maxHtmlBytes: 3 });
  await assert.rejects(() => client.renderHtml("four"), /byte limit/);
  await assert.rejects(() => client.renderHtml("x", { marginTop: "huge" }), /CSS length/);
  await assert.rejects(() => client.renderHtml("x", { paperWidth: "201in" }), /CSS length/);
  await assert.rejects(() => client.renderHtml("x", { paperWidth: "0in" }), /positive/);
  await assert.rejects(() => client.renderHtml("x", { unexpected: "1in" }), /unknown PDF option/);
});

test("rejects oversized, empty, and non-PDF responses", async () => {
  const response = (body, headers = {}) =>
    new Response(body, { status: 200, headers: { "content-type": "application/pdf", ...headers } });
  const oversized = new GotenbergClient({
    baseUrl: "https://pdf.example.test",
    maxPdfBytes: 3,
    fetcher: async () => response(new TextEncoder().encode("%PDF-1.4")),
  });
  await assert.rejects(() => oversized.renderHtml("x"), /PDF exceeds/);

  const empty = new GotenbergClient({
    baseUrl: "https://pdf.example.test",
    fetcher: async () => response(null),
  });
  await assert.rejects(() => empty.renderHtml("x"), /empty PDF/);

  const wrongType = new GotenbergClient({
    baseUrl: "https://pdf.example.test",
    fetcher: async () => new Response("ok", { headers: { "content-type": "text/plain" } }),
  });
  await assert.rejects(() => wrongType.renderHtml("x"), /non-PDF/);

  const malformed = new GotenbergClient({
    baseUrl: "https://pdf.example.test",
    fetcher: async () => response(new Uint8Array([1, 2, 3, 4, 5])),
  });
  await assert.rejects(() => malformed.renderHtml("x"), /malformed PDF/);
});

test("caps provider error details before buffering the response", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(400)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new GotenbergClient({
    baseUrl: "https://pdf.example.test",
    fetcher: async () => new Response(stream, { status: 500 }),
  });
  const error = await client.renderHtml("x").catch((caught) => caught);
  assert.match(error.message, /500/);
  assert.ok(error.message.length < 550);
  assert.equal(cancelled, true);
});

test("aborts a render that exceeds its timeout", async () => {
  const client = new GotenbergClient({
    baseUrl: "https://pdf.example.test",
    timeoutMs: 5,
    fetcher: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
  });
  await assert.rejects(() => client.renderHtml("x"), /abort|timed out|timeout/i);
});

test("hard deadlines reject ignored aborts during fetch and response reads", async () => {
  const hungFetch = new GotenbergClient({
    baseUrl: "https://pdf.example.test",
    timeoutMs: 5,
    fetcher: async () => new Promise(() => {}),
  });
  await assert.rejects(() => hungFetch.renderHtml("x"), /timed out/);

  for (const status of [200, 500]) {
    const stream = new ReadableStream({ pull: async () => new Promise(() => {}) });
    const stalled = new GotenbergClient({
      baseUrl: "https://pdf.example.test",
      timeoutMs: 5,
      fetcher: async () => new Response(stream, {
        status,
        headers: status === 200 ? { "content-type": "application/pdf" } : {},
      }),
    });
    await assert.rejects(() => stalled.renderHtml("x"));
  }
});

test("cancels successful response bodies rejected before streaming", async () => {
  for (const headers of [
    { "content-type": "text/plain" },
    { "content-type": "application/pdf", "content-length": "100" },
  ]) {
    let cancelled = false;
    const stream = new ReadableStream({
      pull() {},
      cancel() { cancelled = true; },
    });
    const client = new GotenbergClient({
      baseUrl: "https://pdf.example.test",
      maxPdfBytes: 10,
      fetcher: async () => new Response(stream, { status: 200, headers }),
    });
    await assert.rejects(() => client.renderHtml("x"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  }
});

test("hung stream cancellation cannot block error-cap or PDF-overflow failures", async () => {
  for (const scenario of ["error", "pdf"]) {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          scenario === "error" ? "x".repeat(600) : "%PDF-1.4",
        ));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    });
    const client = new GotenbergClient({
      baseUrl: "https://pdf.example.test",
      maxPdfBytes: 5,
      fetcher: async () => new Response(stream, {
        status: scenario === "error" ? 500 : 200,
        headers: scenario === "pdf" ? { "content-type": "application/pdf" } : {},
      }),
    });
    await assert.rejects(
      () => client.renderHtml("x"),
      scenario === "error" ? /render failed/ : /PDF exceeds/,
    );
    assert.equal(cancelled, true);
  }
});
