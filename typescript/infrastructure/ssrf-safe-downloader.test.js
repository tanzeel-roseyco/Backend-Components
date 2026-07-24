const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isPrivateAddress,
  buildPinnedRequestOptions,
  safeDownloadForTest,
} = require("../.test-dist/infrastructure/ssrf-safe-downloader.js");

function body(...chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function response(status, chunks = [], headers = {}) {
  return { status, headers, body: body(...chunks), destroy() {} };
}

test("downloads from a DNS-pinned exact host and manually revalidates redirects", async () => {
  const pins = [];
  const result = await safeDownloadForTest("https://media.example.test/start", {
    exactHosts: ["media.example.test"],
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
  }, async (url, address) => {
      pins.push([url.pathname, address]);
      return url.pathname === "/start"
        ? response(302, [], { location: "/asset" })
        : response(200, [new Uint8Array([1, 2, 3])]);
  });
  assert.deepEqual([...result], [1, 2, 3]);
  assert.deepEqual(pins, [["/start", "8.8.8.8"], ["/asset", "8.8.8.8"]]);
});

test("rejects disallowed, private, IPv6, and misleading suffix hosts", async () => {
  const requestForTest = async () => response(200);
  await assert.rejects(
    () => safeDownloadForTest("https://evil.test/x", {
      exactHosts: ["example.test"],
      resolve: async () => [],
    }, requestForTest),
    /not allowed/,
  );
  await assert.rejects(
    () => safeDownloadForTest("https://example.test/x", {
      exactHosts: ["example.test"],
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    }, requestForTest),
    /private/,
  );
  assert.equal(isPrivateAddress("::ffff:7f00:1"), true);
  assert.equal(isPrivateAddress("ff02::1"), true);
  assert.equal(isPrivateAddress("203.0.113.8"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("192.88.99.1"), true);
});

test("enforces total deadlines even when DNS, request, or body ignores abort", async () => {
  const base = {
    exactHosts: ["example.test"],
    timeoutMs: 5,
    resolve: async () => [{ address: "1.1.1.1", family: 4 }],
  };
  await assert.rejects(
    () => safeDownloadForTest("https://example.test/x", {
      ...base,
      resolve: async () => new Promise(() => {}),
    }, async () => response(200)),
    /DNS resolution timed out/,
  );
  await assert.rejects(
    () => safeDownloadForTest("https://example.test/x", base, async () => new Promise(() => {})),
    /request timed out/,
  );
  await assert.rejects(
    () => safeDownloadForTest("https://example.test/x", base, async () => ({
        ...response(200),
        body: { [Symbol.asyncIterator]: () => ({ next: async () => new Promise(() => {}) }) },
      })),
    /body timed out/,
  );
});

test("caps streamed and declared bodies and destroys early responses", async () => {
  let destroyed = 0;
  const make = (headers, chunks) => ({
    ...response(200, chunks, headers),
    destroy() { destroyed += 1; },
  });
  const base = {
    exactHosts: ["example.test"],
    maxBytes: 2,
    resolve: async () => [{ address: "1.1.1.1", family: 4 }],
  };
  await assert.rejects(
    () => safeDownloadForTest("https://example.test/x", base, async () => make({}, [new Uint8Array([1, 2, 3])])),
    /byte limit/,
  );
  await assert.rejects(
    () => safeDownloadForTest("https://example.test/x", base, async () => make({ "content-length": "3" }, [])),
    /byte limit/,
  );
  assert.equal(destroyed, 2);
});

test("rejects malformed options and pins native HTTPS request options", async () => {
  await assert.rejects(() => safeDownloadForTest("https://example.test", null, async () => response(200)), /options/);
  await assert.rejects(
    () => safeDownloadForTest("https://example.test", { exactHosts: ["com"] }, async () => response(200)),
    /invalid hostname/,
  );
  const options = buildPinnedRequestOptions(new URL("https://media.example.test:444/a?q=1"), "8.8.8.8");
  assert.equal(options.hostname, "media.example.test");
  assert.equal(options.servername, "media.example.test");
  assert.equal(options.headers.host, "media.example.test:444");
  assert.equal(options.agent, false);
  assert.equal(options.path, "/a?q=1");
  await new Promise((resolve, reject) =>
    options.lookup("ignored", {}, (error, address, family) => {
      if (error) return reject(error);
      try {
        assert.equal(address, "8.8.8.8");
        assert.equal(family, 4);
        resolve();
      } catch (caught) {
        reject(caught);
      }
    }),
  );
});
