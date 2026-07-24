import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";

function nowSeconds(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("clock must return a non-negative safe integer");
  return Math.floor(value / 1_000);
}

function bounded(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > maximum) throw new Error(`${name} cannot exceed ${maximum} characters`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface PkceTransaction {
  readonly stateHash: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

export interface PkceTransactionStore {
  readonly create: (transaction: PkceTransaction) => Promise<void>;
  /** Atomically deletes and returns the transaction; null covers unknown, expired, and replayed state. */
  readonly consume: (stateHash: string, nowMs: number) => Promise<PkceTransaction | null>;
}

export interface StartedPkceTransaction {
  readonly state: string;
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
  readonly expiresAt: number;
  readonly redirectUri: string;
}

export async function startPkceTransaction(
  store: PkceTransactionStore,
  redirectUri: string,
  options: { readonly now?: () => number; readonly ttlMs?: number; readonly random?: (size: number) => Uint8Array } = {},
): Promise<StartedPkceTransaction> {
  const now = options.now ?? Date.now;
  const nowMs = nowSeconds(now) * 1_000;
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 60_000) {
    throw new Error("ttlMs must be between 60000 and 1800000");
  }
  const callback = new URL(bounded(redirectUri, "redirectUri", 2_000));
  if (!["https:", "http:"].includes(callback.protocol) || callback.username || callback.password || callback.hash) {
    throw new Error("redirectUri must be a credential-free HTTP(S) URL without a fragment");
  }
  if (callback.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(callback.hostname)) {
    throw new Error("HTTP redirectUri is allowed only for loopback callbacks");
  }
  const random = options.random ?? randomBytes;
  const state = Buffer.from(random(32)).toString("base64url");
  const verifier = Buffer.from(random(32)).toString("base64url");
  if (state.length < 43 || verifier.length < 43) throw new Error("random source returned insufficient entropy");
  const expiresAt = safeAdd(nowMs, ttlMs, "PKCE expiry");
  const validatedRedirectUri = callback.toString();
  await store.create({ stateHash: sha256(state), verifier, redirectUri: validatedRedirectUri, expiresAt });
  return {
    state,
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    method: "S256",
    expiresAt,
    redirectUri: validatedRedirectUri,
  };
}

export async function consumePkceTransaction(
  store: PkceTransactionStore,
  state: string,
  now: () => number = Date.now,
): Promise<PkceTransaction> {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(state)) throw new Error("OAuth state is invalid");
  const transaction = await store.consume(sha256(state), nowSeconds(now) * 1_000);
  if (!transaction) throw new Error("OAuth state is unknown, expired, or already consumed");
  return transaction;
}

export interface JwksFetcher {
  readonly fetch: (url: string, options: { readonly signal: AbortSignal }) => Promise<Response>;
}

export interface JwtVerifierOptions {
  readonly jwksUrl: string;
  readonly issuers: readonly string[];
  readonly audience: string;
  readonly algorithms?: readonly ("RS256")[];
  readonly fetcher: JwksFetcher;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly fetchTimeoutMs?: number;
  readonly maxJwksBytes?: number;
  readonly clockSkewSeconds?: number;
  readonly refreshCooldownMs?: number;
}

export interface VerifiedJwt {
  readonly header: Readonly<Record<string, unknown>>;
  readonly claims: Readonly<Record<string, unknown>>;
}

interface Jwk {
  readonly kty?: unknown;
  readonly kid?: unknown;
  readonly alg?: unknown;
  readonly use?: unknown;
  readonly n?: unknown;
  readonly e?: unknown;
  readonly key_ops?: unknown;
}

export class JwksJwtVerifier {
  private readonly now: () => number;
  private readonly algorithms: ReadonlySet<string>;
  private readonly jwksUrl: string;
  private readonly cacheTtlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxJwksBytes: number;
  private readonly clockSkewSeconds: number;
  private readonly refreshCooldownMs: number;
  private keys = new Map<string, Jwk>();
  private cacheExpiresAt = 0;
  private refreshInFlight?: Promise<void>;
  private unknownKidRefreshBlockedUntil = 0;
  private signatureRefreshBlockedUntil = 0;

  public constructor(private readonly options: JwtVerifierOptions) {
    this.now = options.now ?? Date.now;
    this.algorithms = new Set(options.algorithms ?? ["RS256"]);
    if (this.algorithms.size === 0) throw new Error("at least one JWT algorithm is required");
    if (!options.issuers.length) throw new Error("at least one issuer is required");
    bounded(options.audience, "audience", 512);
    const jwksUrl = new URL(options.jwksUrl);
    if (jwksUrl.protocol !== "https:" || jwksUrl.username || jwksUrl.password || jwksUrl.hash) {
      throw new Error("jwksUrl must be a credential-free HTTPS URL without a fragment");
    }
    this.jwksUrl = jwksUrl.toString();
    this.cacheTtlMs = integerOption(options.cacheTtlMs ?? 5 * 60_000, "cacheTtlMs", 60_000, 3_600_000);
    this.fetchTimeoutMs = integerOption(options.fetchTimeoutMs ?? 10_000, "fetchTimeoutMs", 1, 60_000);
    this.maxJwksBytes = integerOption(options.maxJwksBytes ?? 100_000, "maxJwksBytes", 1, 1_000_000);
    this.clockSkewSeconds = integerOption(options.clockSkewSeconds ?? 60, "clockSkewSeconds", 0, 300);
    this.refreshCooldownMs = integerOption(options.refreshCooldownMs ?? 60_000, "refreshCooldownMs", 1_000, 300_000);
    nowSeconds(this.now);
  }

  public async verify(token: string): Promise<VerifiedJwt> {
    bounded(token, "token", 20_000);
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
      throw new Error("JWT must use compact serialization");
    }
    const header = decodeObject(parts[0], "JWT header");
    const claims = decodeObject(parts[1], "JWT claims");
    const alg = typeof header.alg === "string" ? header.alg : "";
    const kid = typeof header.kid === "string" ? bounded(header.kid, "kid", 256) : "";
    if (!this.algorithms.has(alg)) throw new Error("JWT algorithm is not allowed");
    if (!kid) throw new Error("JWT kid is required");
    let key = await this.key(kid);
    if (!key) {
      await this.refreshForReason("unknown-kid");
      key = this.keys.get(kid);
    }
    if (!key) throw new Error("JWT kid was not found");
    let valid = this.verifyWithKey(key, alg, `${parts[0]}.${parts[1]}`, parts[2]);
    if (!valid && await this.refreshForReason("invalid-signature")) {
      key = this.keys.get(kid);
      valid = Boolean(key && this.verifyWithKey(key, alg, `${parts[0]}.${parts[1]}`, parts[2]));
    }
    if (!valid) throw new Error("JWT signature is invalid");
    this.validateClaims(claims);
    return { header, claims };
  }

  private verifyWithKey(key: Jwk, alg: string, input: string, signature: string): boolean {
    if (key.kty !== "RSA" || key.alg !== alg || (key.use !== undefined && key.use !== "sig") ||
        (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify"))) ||
        typeof key.n !== "string" || typeof key.e !== "string") {
      throw new Error("JWKS key is incompatible with JWT header");
    }
    const modulus = decodeCanonicalBase64Url(key.n, "RSA modulus");
    const exponent = decodeCanonicalBase64Url(key.e, "RSA exponent");
    if (bitLength(modulus) < 2048) throw new Error("JWKS RSA modulus must be at least 2048 bits");
    if (exponent.length < 1 || exponent.length > 4 || exponent[0] === 0) {
      throw new Error("JWKS RSA exponent is invalid");
    }
    let exponentValue = 0;
    for (const byte of exponent) exponentValue = exponentValue * 256 + byte;
    if (exponentValue < 3 || exponentValue % 2 === 0) throw new Error("JWKS RSA exponent is invalid");
    let publicKey;
    try {
      publicKey = createPublicKey({
        key: { kty: "RSA", n: key.n, e: key.e },
        format: "jwk",
      } as Parameters<typeof createPublicKey>[0]);
    } catch {
      throw new Error("JWKS RSA key could not be imported");
    }
    return verifySignature(
      "RSA-SHA256",
      Buffer.from(input),
      publicKey,
      decodeCanonicalBase64Url(signature, "JWT signature"),
    );
  }

  private validateClaims(claims: Readonly<Record<string, unknown>>): void {
    const now = nowSeconds(this.now);
    if (typeof claims.iss !== "string" || !this.options.issuers.includes(claims.iss)) {
      throw new Error("JWT issuer is invalid");
    }
    const audiences = typeof claims.aud === "string"
      ? [claims.aud]
      : Array.isArray(claims.aud) && claims.aud.every((value) => typeof value === "string")
        ? claims.aud
        : [];
    if (!audiences.includes(this.options.audience)) throw new Error("JWT audience is invalid");
    if (!Number.isSafeInteger(claims.exp) || (claims.exp as number) + this.clockSkewSeconds <= now) {
      throw new Error("JWT is expired");
    }
    if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) ||
        (claims.nbf as number) > now + this.clockSkewSeconds)) {
      throw new Error("JWT is not active");
    }
    if (!Number.isSafeInteger(claims.iat) || (claims.iat as number) > now + this.clockSkewSeconds) {
      throw new Error("JWT issued-at time is invalid");
    }
  }

  private async key(kid: string): Promise<Jwk | undefined> {
    if (nowSeconds(this.now) * 1_000 >= this.cacheExpiresAt || this.keys.size === 0) await this.refresh(false);
    return this.keys.get(kid);
  }

  private async refresh(force: boolean): Promise<void> {
    if (!force && nowSeconds(this.now) * 1_000 < this.cacheExpiresAt && this.keys.size > 0) return;
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.fetchKeys().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    await this.refreshInFlight;
  }

  private async refreshForReason(reason: "unknown-kid" | "invalid-signature"): Promise<boolean> {
    const now = nowSeconds(this.now) * 1_000;
    const blockedUntil = reason === "unknown-kid"
      ? this.unknownKidRefreshBlockedUntil
      : this.signatureRefreshBlockedUntil;
    if (blockedUntil > now) return false;
    const next = safeAdd(now, this.refreshCooldownMs, "JWKS refresh cooldown");
    if (reason === "unknown-kid") this.unknownKidRefreshBlockedUntil = next;
    else this.signatureRefreshBlockedUntil = next;
    await this.refresh(true);
    return true;
  }

  private async fetchKeys(): Promise<void> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("JWKS fetch timed out"));
      }, this.fetchTimeoutMs);
    });
    try {
      const load = async (): Promise<Uint8Array> => {
        const response = await this.options.fetcher.fetch(this.jwksUrl, { signal: controller.signal });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`JWKS fetch failed (${response.status})`);
        }
        return readBounded(response, this.maxJwksBytes);
      };
      const bytes = await Promise.race([load(), deadline]);
      const payload = decodeJsonBytes(bytes, "JWKS");
      if (!Array.isArray(payload.keys) || payload.keys.length < 1 || payload.keys.length > 100) {
        throw new Error("JWKS keys must contain 1 to 100 items");
      }
      const next = new Map<string, Jwk>();
      for (const candidate of payload.keys) {
        if (!isRecord(candidate) || typeof candidate.kid !== "string" || candidate.kid.length > 256) {
          throw new Error("JWKS contained an invalid key");
        }
        if (next.has(candidate.kid)) throw new Error("JWKS contained a duplicate kid");
        next.set(candidate.kid, candidate);
      }
      this.keys = next;
      this.cacheExpiresAt = safeAdd(nowSeconds(this.now) * 1_000, this.cacheTtlMs, "JWKS cache expiry");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export interface InviteClaimStore<TClaim extends object> {
  readonly create: (input: { readonly tokenHash: string; readonly claim: TClaim; readonly expiresAt: number }) => Promise<void>;
  /** Atomically marks the hash used and returns its claim; null covers expired, unknown, and replayed tokens. */
  readonly consume: (tokenHash: string, nowMs: number) => Promise<TClaim | null>;
}

export async function issueInvite<TClaim extends object>(
  store: InviteClaimStore<TClaim>,
  claim: TClaim,
  options: { readonly now?: () => number; readonly ttlMs?: number; readonly random?: (size: number) => Uint8Array } = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const nowMs = nowSeconds(now) * 1_000;
  if (claim === null || claim === undefined) throw new Error("invite claim is required");
  const ttlMs = integerOption(options.ttlMs ?? 24 * 60 * 60_000, "ttlMs", 60_000, 30 * 24 * 60 * 60_000);
  const token = Buffer.from((options.random ?? randomBytes)(32)).toString("base64url");
  if (token.length < 43) throw new Error("random source returned insufficient entropy");
  await store.create({ tokenHash: sha256(token), claim, expiresAt: safeAdd(nowMs, ttlMs, "invite expiry") });
  return token;
}

export async function claimInvite<TClaim extends object>(
  store: InviteClaimStore<TClaim>,
  token: string,
  now: () => number = Date.now,
): Promise<TClaim> {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error("invite token is invalid");
  const claim = await store.consume(sha256(token), nowSeconds(now) * 1_000);
  if (claim === null) throw new Error("invite token is unknown, expired, or already claimed");
  return claim;
}

function integerOption(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function decodeObject(value: string, name: string): Readonly<Record<string, unknown>> {
  return decodeJsonBytes(decodeCanonicalBase64Url(value, name), name);
}

function decodeJsonBytes(value: Uint8Array, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch {
    throw new Error(`${name} was not valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${name} must be an object`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCanonicalBase64Url(value: string, name: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} was not canonical base64url`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error(`${name} was not canonical base64url`);
  return bytes;
}

function bitLength(bytes: Uint8Array): number {
  if (bytes.length === 0 || bytes[0] === 0) return 0;
  return (bytes.length - 1) * 8 + (32 - Math.clz32(bytes[0]));
}

function safeAdd(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`${name} exceeded the safe date range`);
  return result;
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new Error("JWKS response exceeded the size limit");
  }
  if (!response.body) throw new Error("JWKS response body was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("JWKS response exceeded the size limit");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
