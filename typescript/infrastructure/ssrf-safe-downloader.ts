import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

interface PinnedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  destroy(error?: Error): void;
}

type PinnedRequester = (url: URL, address: string, signal: AbortSignal) => Promise<PinnedResponse>;

export interface SafeDownloadOptions {
  readonly exactHosts: readonly string[];
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly resolve?: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly { address: string; family: number }[]>;
}

const BLOCKED_V4 = [
  [0x00000000, 0xff000000],
  [0x0a000000, 0xff000000],
  [0x64400000, 0xffc00000],
  [0x7f000000, 0xff000000],
  [0xa9fe0000, 0xffff0000],
  [0xac100000, 0xfff00000],
  [0xc0000000, 0xffffff00],
  [0xc0000200, 0xffffff00],
  [0xc0586300, 0xffffff00],
  [0xc0a80000, 0xffff0000],
  [0xc6120000, 0xfffe0000],
  [0xc6336400, 0xffffff00],
  [0xcb007100, 0xffffff00],
  [0xe0000000, 0xf0000000],
  [0xf0000000, 0xf0000000],
] as const;

function ipv4Number(address: string): number {
  return address.split(".").reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

/** This conservative implementation permits only globally routable IPv4 unicast. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) !== 4) return true;
  const value = ipv4Number(address);
  return BLOCKED_V4.some(([network, mask]) => (value & mask) === (network & mask));
}

function hostList(values: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
    throw new Error("exactHosts must contain 1-100 hosts");
  }
  return values.map((value) => {
    if (typeof value !== "string" || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)) {
      throw new Error("exactHosts contains an invalid hostname");
    }
    return value.toLowerCase();
  });
}

/** Internal test hook: the returned lookup is pinned and never delegates to DNS. */
export function buildPinnedRequestOptions(url: URL, address: string): RequestOptions {
  return {
      protocol: "https:",
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      agent: false,
      servername: url.hostname,
      headers: { host: url.host },
      // The socket receives the already-validated address; TLS still authenticates the hostname.
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
  };
}

function nativePinnedRequest(url: URL, address: string, signal: AbortSignal): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const options = buildPinnedRequestOptions(url, address);
    const request = httpsRequest(options, (response: IncomingMessage) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: {
          location: Array.isArray(response.headers.location)
            ? response.headers.location[0]
            : response.headers.location,
          "content-length": response.headers["content-length"],
        },
        body: response,
        destroy: (error?: Error) => response.destroy(error),
      });
    });
    const abort = () => request.destroy(new Error("download timed out"));
    signal.addEventListener("abort", abort, { once: true });
    request.once("error", reject);
    request.once("close", () => signal.removeEventListener("abort", abort));
    request.end();
  });
}

async function withDeadline<T>(
  operation: Promise<T>,
  controller: AbortController,
  remainingMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timed out`));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Downloads through a concrete DNS-pinned HTTPS socket and manually validates redirects. */
async function downloadWithRequester(
  url: string,
  options: SafeDownloadOptions,
  requester: PinnedRequester,
): Promise<Uint8Array> {
  if (!options || typeof options !== "object") throw new Error("options are required");
  const exactHosts = hostList(options.exactHosts);
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 3;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) {
    throw new Error("maxBytes must be between 1 and 104857600");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("timeoutMs must be between 1 and 120000");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new Error("maxRedirects must be between 0 and 10");
  }

  const resolver = options.resolve ?? (async (hostname: string) => lookup(hostname, { all: true }));
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let response: PinnedResponse | undefined;
  try {
    let current = new URL(url);
    for (let redirects = 0; ; redirects += 1) {
      if (current.protocol !== "https:" || current.username || current.password || current.hash) {
        throw new Error("download URL must be credential-free HTTPS without a fragment");
      }
      const host = current.hostname.toLowerCase();
      if (!exactHosts.includes(host)) {
        throw new Error("download host is not allowed");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("download timed out");
      const addresses = await withDeadline(
        resolver(host, controller.signal),
        controller,
        remaining,
        "download DNS resolution",
      );
      const publicAddresses = addresses
        .filter(({ family, address }) => family === 4 && !isPrivateAddress(address))
        .map(({ address }) => address);
      if (!publicAddresses.length || publicAddresses.length !== addresses.length) {
        throw new Error("download host resolved to a private or invalid address");
      }

      response = await withDeadline(
        requester(current, publicAddresses[0], controller.signal),
        controller,
        deadline - Date.now(),
        "download request",
      );
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= maxRedirects) throw new Error("download exceeded redirect limit");
        const location = response.headers.location;
        if (!location) throw new Error("download redirect has no location");
        response.destroy();
        response = undefined;
        current = new URL(location, current);
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`download failed (${response.status})`);
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error("download exceeds byte limit");

      const chunks: Uint8Array[] = [];
      let total = 0;
      const iterator = response.body[Symbol.asyncIterator]();
      while (true) {
        const item = await withDeadline(iterator.next(), controller, deadline - Date.now(), "download body");
        if (item.done) break;
        total += item.value.byteLength;
        if (total > maxBytes) throw new Error("download exceeds byte limit");
        chunks.push(item.value);
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      response = undefined;
      return body;
    }
  } finally {
    controller.abort();
    response?.destroy();
  }
}

export function safeDownload(url: string, options: SafeDownloadOptions): Promise<Uint8Array> {
  return downloadWithRequester(url, options, nativePinnedRequest);
}

/** Separate test entry point; production callers should use safeDownload. */
export function safeDownloadForTest(
  url: string,
  options: SafeDownloadOptions,
  requester: PinnedRequester,
): Promise<Uint8Array> {
  return downloadWithRequester(url, options, requester);
}
