const assert = require("node:assert/strict");
const test = require("node:test");
const {
  GoogleApiError,
  GoogleWorkspaceRestClient,
} = require("../.test-dist/integrations/google-workspace-rest.js");

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Failure",
    headers: { "content-type": "application/json", ...headers },
  });

test("caches one token while Drive and RAW Sheets operations succeed", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("oauth2.googleapis.com")) {
      return json({ access_token: "access", expires_in: 3600 });
    }
    if (String(url).includes("/drive/v3/files?")) {
      return json({ files: [{ id: "folder-1", name: "Reports" }] });
    }
    return json({ updatedCells: 2 });
  };
  const client = new GoogleWorkspaceRestClient({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetch,
    now: () => 1_000,
  });

  const folder = await client.findOrCreateSharedDriveFolder("drive", "root", "Reports");
  await client.updateSheetValues("sheet", "Tab!A1:B1", [["a", "b"]]);
  await client.clearSheetValues("sheet", "Tab!A2");
  await client.batchUpdateSheetValues("sheet", [{ range: "Tab!A3", values: [[1]] }]);

  assert.deepEqual(folder, { id: "folder-1", name: "Reports" });
  assert.equal(calls.filter((call) => call.url.includes("oauth2.googleapis.com")).length, 1);
  assert.match(calls.at(-1).init.body, /"valueInputOption":"RAW"/);
});

test("rejects invalid inputs before making a request", async () => {
  let called = false;
  const client = new GoogleWorkspaceRestClient({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetch: async () => {
      called = true;
      return json({});
    },
  });

  await assert.rejects(() => client.batchUpdateSheetValues("sheet", []), /1 to 100 ranges/);
  await assert.rejects(() => client.deleteDriveFile(""), /non-empty string/);
  assert.equal(called, false);
});

test("caps Google error bodies and treats a missing Drive file as deleted", async () => {
  let apiCalls = 0;
  const client = new GoogleWorkspaceRestClient({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetch: async (url) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return json({ access_token: "access", expires_in: 3600 });
      }
      apiCalls += 1;
      if (apiCalls === 1) return new Response("gone", { status: 404, statusText: "Not Found" });
      return new Response("x".repeat(2_000), { status: 500, statusText: "Failure" });
    },
  });

  await client.deleteDriveFile("already-gone");
  await assert.rejects(
    () => client.clearSheetValues("sheet", "A1"),
    (error) =>
      error instanceof GoogleApiError &&
      error.name === "GoogleApiError" &&
      error.status === 500 &&
      error.message.length < 600 &&
      error.message.includes("x".repeat(100))
  );
});

test("coalesces refreshes, retries one 401, and recovers after refresh failure", async () => {
  let refreshes = 0;
  let apiCalls = 0;
  const fetch = async (url) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      refreshes += 1;
      await Promise.resolve();
      if (refreshes === 1) return new Response("temporary", { status: 503 });
      return json({ access_token: `access-${refreshes}`, expires_in: 3600 });
    }
    apiCalls += 1;
    if (apiCalls === 1) return new Response("", { status: 401 });
    return json({ clearedRange: "A1" });
  };
  const client = new GoogleWorkspaceRestClient({
    clientId: "id", clientSecret: "secret", refreshToken: "refresh", fetch,
  });

  const failed = await Promise.allSettled([
    client.clearSheetValues("sheet", "A1"),
    client.clearSheetValues("sheet", "A2"),
  ]);
  assert.deepEqual(failed.map(({ status }) => status), ["rejected", "rejected"]);
  assert.equal(refreshes, 1);

  await client.clearSheetValues("sheet", "A1");
  assert.equal(refreshes, 3);
  assert.equal(apiCalls, 2);
});

test("escapes special Drive query names and coalesces same-folder creation", async () => {
  const urls = [];
  let creates = 0;
  const fetch = async (url, init = {}) => {
    urls.push(String(url));
    if (String(url).includes("oauth2.googleapis.com")) {
      return json({ access_token: "access", expires_in: 3600 });
    }
    if (init.method === "POST") {
      creates += 1;
      return json({ id: "folder", name: "Bob's \\\\ Reports" });
    }
    await Promise.resolve();
    return json({ files: [] });
  };
  const client = new GoogleWorkspaceRestClient({
    clientId: "id", clientSecret: "secret", refreshToken: "refresh", fetch,
  });
  const name = "Bob's \\\\ Reports";
  const [first, second] = await Promise.all([
    client.findOrCreateSharedDriveFolder("drive", "root", name),
    client.findOrCreateSharedDriveFolder("drive", "root", name),
  ]);

  assert.deepEqual(first, second);
  assert.equal(creates, 1);
  const query = new URL(urls.find((url) => url.includes("/drive/v3/files?"))).searchParams.get("q");
  assert.match(query, /Bob\\'s \\\\\\\\ Reports/);
});

test("accepts exact zero-byte uploads and rejects unapproved session origins", async () => {
  let sessionOrigin = "https://www.googleapis.com/upload/drive/v3/files?upload_id=1";
  const puts = [];
  const fetch = async (url, init = {}) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      return json({ access_token: "access", expires_in: 3600 });
    }
    if (String(url).includes("uploadType=resumable")) {
      return new Response("", { status: 200, headers: { location: sessionOrigin } });
    }
    puts.push({
      bytes: [...new Uint8Array(await new Response(init.body).arrayBuffer())],
      authorization: new Headers(init.headers).get("authorization"),
    });
    return json({ id: "file-1" });
  };
  const client = new GoogleWorkspaceRestClient({
    clientId: "id", clientSecret: "secret", refreshToken: "refresh", fetch,
  });

  assert.deepEqual(
    await client.uploadFileViaResumableSession({ name: "empty.txt" }, "", "text/plain", 0),
    { id: "file-1" }
  );
  await client.uploadFileViaResumableSession({ name: "utf8.txt" }, "é", "text/plain", 2);
  await client.uploadFileViaResumableSession(
    { name: "binary.bin" },
    new Uint8Array([0, 255]),
    "application/octet-stream",
    2
  );
  assert.deepEqual(puts, [
    { bytes: [], authorization: "Bearer access" },
    { bytes: [195, 169], authorization: "Bearer access" },
    { bytes: [0, 255], authorization: "Bearer access" },
  ]);
  await assert.rejects(
    () => client.uploadFileViaResumableSession({ name: "bad.txt" }, "x", "text/plain", 0),
    /exactly match/
  );
  sessionOrigin = "https://attacker.example/upload/drive/v3/files?upload_id=2";
  await assert.rejects(
    () => client.uploadFileViaResumableSession({ name: "x" }, "x", "text/plain", 1),
    /unapproved/
  );
});

test("enforces Sheets range, row, and cell limits before network access", async () => {
  let called = false;
  const client = new GoogleWorkspaceRestClient({
    clientId: "id", clientSecret: "secret", refreshToken: "refresh",
    fetch: async () => {
      called = true;
      return json({});
    },
  });
  const range = (index, values = [[index]]) => ({ range: `A${index}`, values });

  await assert.rejects(
    () => client.batchUpdateSheetValues("sheet", Array.from({ length: 101 }, (_, i) => range(i))),
    /1 to 100 ranges/
  );
  await assert.rejects(
    () => client.updateSheetValues("sheet", "A1", Array.from({ length: 10_001 }, () => [])),
    /10000 rows/
  );
  await assert.rejects(
    () => client.updateSheetValues("sheet", "A1", [Array(50_001).fill("x")]),
    /50000 cells/
  );
  await assert.rejects(
    () => client.updateSheetValues("sheet", "A1", [["x".repeat(5_000_000)]]),
    /5000000 bytes/
  );
  assert.equal(called, false);
});

test("a staggered old-token 401 does not discard a newer token", async () => {
  let refreshes = 0;
  let oldCalls = 0;
  let releaseLate401;
  const late401 = new Promise((resolve) => { releaseLate401 = resolve; });
  const fetch = async (url, init = {}) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      refreshes += 1;
      if (refreshes === 2) releaseLate401();
      return json({ access_token: `token-${refreshes}`, expires_in: 3600 });
    }
    const authorization = new Headers(init.headers).get("authorization");
    if (authorization === "Bearer token-1") {
      oldCalls += 1;
      if (oldCalls === 2) await late401;
      return new Response("", { status: 401 });
    }
    return json({ clearedRange: "A1" });
  };
  const client = new GoogleWorkspaceRestClient({
    clientId: "id", clientSecret: "secret", refreshToken: "refresh", fetch,
  });

  await Promise.all([
    client.clearSheetValues("sheet", "A1"),
    client.clearSheetValues("sheet", "A2"),
  ]);
  assert.equal(refreshes, 2);
});

test("bounds response streaming and request time", async () => {
  const oversized = new GoogleWorkspaceRestClient({
    clientId: "id", clientSecret: "secret", refreshToken: "refresh",
    fetch: async (url) => String(url).includes("oauth2.googleapis.com")
      ? json({ access_token: "token", expires_in: 3600 })
      : json({ value: "x".repeat(1_000_000) }),
  });
  await assert.rejects(() => oversized.clearSheetValues("sheet", "A1"), /1000000 bytes/);

  const timed = new GoogleWorkspaceRestClient({
    clientId: "id", clientSecret: "secret", refreshToken: "refresh", timeoutMs: 5,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }),
  });
  await assert.rejects(() => timed.clearSheetValues("sheet", "A1"), /abort|timed out/i);
});

test("hard deadlines reject fetchers and response readers that ignore abort", async () => {
  const hungFetch = new GoogleWorkspaceRestClient({
    clientId: "id", clientSecret: "secret", refreshToken: "refresh", timeoutMs: 5,
    fetch: async () => new Promise(() => {}),
  });
  await assert.rejects(
    () => hungFetch.clearSheetValues("sheet", "A1"),
    /timed out/
  );

  const stalledBody = new ReadableStream({
    pull: async () => new Promise(() => {}),
    cancel: async () => new Promise(() => {}),
  });
  const stalledRead = new GoogleWorkspaceRestClient({
    clientId: "id", clientSecret: "secret", refreshToken: "refresh", timeoutMs: 5,
    fetch: async (url) => String(url).includes("oauth2.googleapis.com")
      ? json({ access_token: "token", expires_in: 3600 })
      : new Response(stalledBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
  });
  await assert.rejects(
    () => stalledRead.clearSheetValues("sheet", "A1"),
    /response timed out/
  );
});

test("snapshots mutable binary uploads before the first await", async () => {
  let releaseSession;
  const sessionGate = new Promise((resolve) => { releaseSession = resolve; });
  const uploaded = [];
  const fetch = async (url, init = {}) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      return json({ access_token: "token", expires_in: 3600 });
    }
    if (String(url).includes("uploadType=resumable")) {
      await sessionGate;
      return new Response("", {
        status: 200,
        headers: { location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=1" },
      });
    }
    uploaded.push([...new Uint8Array(await new Response(init.body).arrayBuffer())]);
    return json({ id: `file-${uploaded.length}` });
  };
  const client = new GoogleWorkspaceRestClient({
    clientId: "id", clientSecret: "secret", refreshToken: "refresh", fetch,
  });
  const bytes = new Uint8Array([1, 2]);
  const buffer = new Uint8Array([3, 4]).buffer;
  const first = client.uploadFileViaResumableSession(
    { name: "bytes.bin" }, bytes, "application/octet-stream", 2
  );
  const second = client.uploadFileViaResumableSession(
    { name: "buffer.bin" }, buffer, "application/octet-stream", 2
  );
  bytes.fill(9);
  new Uint8Array(buffer).fill(8);
  releaseSession();
  await Promise.all([first, second]);
  assert.deepEqual(uploaded, [[1, 2], [3, 4]]);
});

test("successful DELETE starts body cancellation without awaiting a hung cancel", async () => {
  let cancelled = false;
  const client = new GoogleWorkspaceRestClient({
    clientId: "id", clientSecret: "secret", refreshToken: "refresh",
    fetch: async (url) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return json({ access_token: "token", expires_in: 3600 });
      }
      return new Response(new ReadableStream({
        pull() {},
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      }), { status: 200 });
    },
  });
  await client.deleteDriveFile("file-1");
  assert.equal(cancelled, true);
});
