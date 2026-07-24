export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DotloopClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  apiUrl?: string;
  allowedOrigins?: readonly string[];
  onRefreshToken?: (refreshToken: string) => void | Promise<void>;
  fetcher?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  authorizationTtlMs?: number;
  maxPendingAuthorizations?: number;
}

export interface DotloopLoop {
  id: number;
  name: string;
  loopUrl?: string;
  profileId?: number;
  status?: string;
  transactionType?: string;
}

export interface CreateLoopInput {
  name: string;
  transactionType?: string;
  status?: string;
}

export interface AddParticipantInput {
  fullName: string;
  email?: string;
  role: string;
  phone?: string;
}

export interface DotloopAuthorizationTransaction {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

const DEFAULT_AUTH_URL = "https://auth.dotloop.com/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://auth.dotloop.com/oauth/token";
const DEFAULT_API_URL = "https://api-gateway.dotloop.com/public/v2";
const MAX_STRING = 500;
const MAX_ERROR = 500;
const MAX_RESPONSE = 1_000_000;
const TOKEN_SKEW_MS = 60_000;
const MAX_SCOPES = 20;
const DEFAULT_AUTHORIZATION_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING_AUTHORIZATIONS = 100;
const MAX_CLOCK_MS = 8_640_000_000_000_000;
const DOTLOOP_ORIGINS = new Set([
  "https://auth.dotloop.com",
  "https://api-gateway.dotloop.com",
]);

function bounded(value: string, name: string, max = MAX_STRING): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  if (value.length > max) throw new RangeError(`${name} cannot exceed ${max} characters`);
  return value;
}

function positiveId(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function endpoint(value: string, name: string, allowedOrigins: ReadonlySet<string>): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError(`${name} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  if (url.protocol !== "https:" || !allowedOrigins.has(url.origin)) {
    throw new TypeError(`${name} must use an allowed HTTPS origin`);
  }
  return url.toString().replace(/\/+$/, "");
}

function redirectUri(value: string): string {
  bounded(value, "redirectUri", 2_000);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("redirectUri must be an exact HTTPS URL without credentials or fragment");
  }
  return value;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class DotloopClient {
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly authorizationUrl: string;
  private readonly tokenUrl: string;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly authorizationTtlMs: number;
  private readonly maxPendingAuthorizations: number;
  private readonly pendingAuthorizations = new Map<
    string,
    { codeVerifier: string; redirectUri: string; expiresAt: number }
  >();
  private accessToken?: string;
  private expiresAt = 0;
  private refreshInFlight?: Promise<string>;
  private ownedRefreshToken?: string;

  constructor(private readonly options: DotloopClientOptions) {
    bounded(options.clientId, "clientId", 200);
    bounded(options.clientSecret, "clientSecret", 500);
    const allowedOrigins = new Set(DOTLOOP_ORIGINS);
    for (const origin of options.allowedOrigins ?? []) {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.pathname !== "/") {
        throw new TypeError("allowedOrigins entries must be exact HTTPS origins");
      }
      allowedOrigins.add(parsed.origin);
    }
    this.authorizationUrl = endpoint(options.authorizationUrl ?? DEFAULT_AUTH_URL, "authorizationUrl", allowedOrigins);
    this.tokenUrl = endpoint(options.tokenUrl ?? DEFAULT_TOKEN_URL, "tokenUrl", allowedOrigins);
    this.apiUrl = endpoint(options.apiUrl ?? DEFAULT_API_URL, "apiUrl", allowedOrigins);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new RangeError("timeoutMs must be between 1 and 120000");
    }
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.authorizationTtlMs = options.authorizationTtlMs ?? DEFAULT_AUTHORIZATION_TTL_MS;
    if (
      !Number.isSafeInteger(this.authorizationTtlMs) ||
      this.authorizationTtlMs < 1 ||
      this.authorizationTtlMs > 86_400_000
    ) {
      throw new RangeError("authorizationTtlMs must be between 1 and 86400000");
    }
    this.maxPendingAuthorizations =
      options.maxPendingAuthorizations ?? DEFAULT_MAX_PENDING_AUTHORIZATIONS;
    if (
      !Number.isSafeInteger(this.maxPendingAuthorizations) ||
      this.maxPendingAuthorizations < 1 ||
      this.maxPendingAuthorizations > 10_000
    ) {
      throw new RangeError("maxPendingAuthorizations must be between 1 and 10000");
    }
    this.clockMs();
    this.ownedRefreshToken = options.refreshToken
      ? bounded(options.refreshToken, "refreshToken", 2_000)
      : undefined;
  }

  async createAuthorizationTransaction(input: {
    redirectUri: string;
    scope?: readonly string[];
  }): Promise<DotloopAuthorizationTransaction> {
    const exactRedirectUri = redirectUri(input.redirectUri);
    const now = this.clockMs();
    this.purgeExpiredAuthorizations(now);
    if (this.pendingAuthorizations.size >= this.maxPendingAuthorizations) {
      throw new Error("too many pending authorization transactions");
    }
    const expiresAt = now + this.authorizationTtlMs;
    if (!Number.isSafeInteger(expiresAt) || expiresAt > MAX_CLOCK_MS) {
      throw new RangeError("authorization transaction expiry is outside the supported clock range");
    }
    const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)))
    );
    const scopes = [...new Set(input.scope ?? [])];
    if (scopes.length > MAX_SCOPES) throw new RangeError(`scope cannot exceed ${MAX_SCOPES} entries`);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.options.clientId,
      redirect_uri: exactRedirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    if (scopes.length) {
      const joined = scopes.map((scope) => bounded(scope, "scope", 100)).join(" ");
      if (joined.length > 1_000) throw new RangeError("combined scope is too long");
      params.set("scope", joined);
    }
    this.pendingAuthorizations.set(state, {
      codeVerifier,
      redirectUri: exactRedirectUri,
      expiresAt,
    });
    return {
      authorizationUrl: `${this.authorizationUrl}?${params}`,
      state,
      codeVerifier,
      redirectUri: exactRedirectUri,
    };
  }

  async exchangeAuthorizationCallback(input: {
    code: string;
    state: string;
    redirectUri: string;
  }): Promise<{ accessToken: string; refreshToken?: string }> {
    this.purgeExpiredAuthorizations(this.clockMs());
    const transaction = this.pendingAuthorizations.get(input.state);
    this.pendingAuthorizations.delete(input.state);
    if (!transaction) throw new Error("authorization state is invalid or already consumed");
    if (input.redirectUri !== transaction.redirectUri) {
      throw new Error("authorization redirectUri does not match the original transaction");
    }
    const token = await this.tokenRequest({
      grant_type: "authorization_code",
      code: bounded(input.code, "code", 2_000),
      redirect_uri: input.redirectUri,
      code_verifier: transaction.codeVerifier,
    });
    return { accessToken: token.accessToken, refreshToken: token.refreshToken };
  }

  getRefreshToken(): string | undefined {
    return this.ownedRefreshToken;
  }

  async refresh(): Promise<string> {
    const refreshToken = this.ownedRefreshToken;
    if (!refreshToken) throw new Error("this Dotloop client has no refresh token");
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.tokenRequest({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).then((token) => token.accessToken).finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  async getProfiles(): Promise<unknown[]> {
    const data = await this.api<unknown[]>("/profile");
    if (!Array.isArray(data)) throw new Error("Dotloop profiles response was malformed");
    return data;
  }

  async createLoop(profileId: number, input: CreateLoopInput): Promise<DotloopLoop> {
    const body: Record<string, string> = { name: bounded(input.name, "name") };
    if (input.transactionType) body.transactionType = bounded(input.transactionType, "transactionType", 100);
    if (input.status) body.status = bounded(input.status, "status", 100);
    const loop = await this.api<unknown>(`/profile/${positiveId(profileId, "profileId")}/loop`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (
      typeof loop !== "object" ||
      loop === null ||
      !Number.isSafeInteger((loop as DotloopLoop).id) ||
      (loop as DotloopLoop).id < 1 ||
      typeof (loop as DotloopLoop).name !== "string"
    ) {
      throw new Error("Dotloop create-loop response was malformed");
    }
    return loop as DotloopLoop;
  }

  async getLoopTemplates(profileId: number): Promise<unknown[]> {
    const data = await this.api<unknown[]>(
      `/profile/${positiveId(profileId, "profileId")}/loop-template`
    );
    if (!Array.isArray(data)) throw new Error("Dotloop templates response was malformed");
    return data;
  }

  async addParticipant(
    profileId: number,
    loopId: number,
    input: AddParticipantInput,
  ): Promise<unknown> {
    return this.api(
      `/profile/${positiveId(profileId, "profileId")}/loop/${positiveId(loopId, "loopId")}/participant`,
      {
        method: "POST",
        body: JSON.stringify({
          fullName: bounded(input.fullName, "fullName"),
          role: bounded(input.role, "role", 100),
          ...(input.email && { email: bounded(input.email, "email", 320) }),
          ...(input.phone && { Phone: bounded(input.phone, "phone", 50) }),
        }),
      }
    );
  }

  async updateLoopDetails(
    profileId: number,
    loopId: number,
    details: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (!details || typeof details !== "object" || Array.isArray(details) || !Object.keys(details).length) {
      throw new TypeError("details must be a non-empty object");
    }
    const body = JSON.stringify(details);
    if (new TextEncoder().encode(body).byteLength > 100_000) throw new RangeError("details payload is too large");
    return this.api(
      `/profile/${positiveId(profileId, "profileId")}/loop/${positiveId(loopId, "loopId")}/detail`,
      { method: "PATCH", body }
    );
  }

  private async tokenRequest(fields: Record<string, string>): Promise<{
    accessToken: string;
    refreshToken?: string;
  }> {
    const credentials = new TextEncoder().encode(`${this.options.clientId}:${this.options.clientSecret}`);
    const basic = btoa(String.fromCharCode(...credentials));
    const payload = await this.fetchJson(this.tokenUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    });
    if (typeof payload !== "object" || payload === null) throw new Error("Dotloop token response was malformed");
    const token = payload as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    const accessToken = bounded(token.access_token as string, "access_token", 4_000);
    const expiresIn = token.expires_in === undefined ? 43_200 : token.expires_in;
    if (!Number.isSafeInteger(expiresIn) || (expiresIn as number) < 1 || (expiresIn as number) > 86_400) {
      throw new Error("Dotloop token expires_in was malformed");
    }
    const rotatedRefreshToken =
      token.refresh_token === undefined
        ? undefined
        : bounded(token.refresh_token as string, "refresh_token", 2_000);
    if (rotatedRefreshToken && rotatedRefreshToken !== this.ownedRefreshToken) {
      await this.options.onRefreshToken?.(rotatedRefreshToken);
      this.ownedRefreshToken = rotatedRefreshToken;
    }
    // Do not activate the access token until refresh-token rotation is durable.
    this.accessToken = accessToken;
    const expiresAt = this.clockMs() + (expiresIn as number) * 1_000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt > MAX_CLOCK_MS) {
      throw new Error("Dotloop token expiry is outside the supported clock range");
    }
    this.expiresAt = expiresAt;
    return {
      accessToken,
      refreshToken: rotatedRefreshToken,
    };
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.accessToken || this.clockMs() + TOKEN_SKEW_MS >= this.expiresAt) await this.refresh();
    const request = async (accessToken: string): Promise<unknown> =>
      this.fetchJson(`${this.apiUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init.headers, authorization: `Bearer ${accessToken}` },
      });
    const usedToken = this.accessToken;
    if (!usedToken) throw new Error("Dotloop access token was unavailable after refresh");
    try {
      const payload = await request(usedToken);
      return this.unwrap<T>(payload);
    } catch (error) {
      if (!(error instanceof DotloopHttpError) || error.status !== 401) throw error;
      // A later concurrent request may already have replaced the rejected token.
      if (this.accessToken === usedToken) this.accessToken = undefined;
      if (!this.accessToken) await this.refresh();
      const retryToken = this.accessToken;
      if (!retryToken) throw new Error("Dotloop access token was unavailable after refresh");
      return this.unwrap<T>(await request(retryToken));
    }
  }

  private unwrap<T>(payload: unknown): T {
    if (typeof payload !== "object" || payload === null || !("data" in payload)) {
      throw new Error("Dotloop API response was malformed");
    }
    return (payload as { data: T }).data;
  }

  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    try {
      const response = await this.withDeadline(
        this.fetcher(url, { ...init, signal: controller.signal }),
        controller,
        "request",
      );
      const text = await this.readBounded(response, controller);
      if (!response.ok) throw new DotloopHttpError(response.status, text.slice(0, MAX_ERROR));
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("Dotloop response was not valid JSON");
      }
    } finally {
      controller.abort();
    }
  }

  private async readBounded(response: Response, controller: AbortController): Promise<string> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Dotloop response exceeded the size limit");
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    let completed = false;
    try {
      while (true) {
        const chunk = await this.withDeadline(reader.read(), controller, "response read");
        if (chunk.done) {
          completed = true;
          return text + decoder.decode();
        }
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE) throw new Error("Dotloop response exceeded the size limit");
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      // Cancellation is deliberately not awaited: a non-compliant stream may ignore it too.
      if (!completed) void reader.cancel().catch(() => undefined);
    }
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    controller: AbortController,
    label: string,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`Dotloop ${label} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private clockMs(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CLOCK_MS) {
      throw new RangeError("now() must return a non-negative safe integer timestamp");
    }
    return value;
  }

  private purgeExpiredAuthorizations(now: number): void {
    for (const [state, transaction] of this.pendingAuthorizations) {
      if (transaction.expiresAt <= now) this.pendingAuthorizations.delete(state);
    }
  }
}

class DotloopHttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Dotloop request failed (${status})${detail ? `: ${detail}` : ""}`);
  }
}
