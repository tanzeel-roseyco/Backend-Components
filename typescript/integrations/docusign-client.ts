import { createHash, createHmac, createPrivateKey, sign, timingSafeEqual } from "node:crypto";

export interface DocuSignConfig {
  readonly userId: string;
  readonly accountId: string;
  readonly baseUri: string;
  readonly integrationKey: string;
  readonly rsaPrivateKey: string;
  readonly webhookSecrets: readonly string[];
}

export type DocuSignEnvironment = Readonly<Record<string, string | undefined>>;

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function bounded(value: string, name: string, maximum: number): string {
  if (value.length > maximum) throw new Error(`${name} cannot exceed ${maximum} characters`);
  return value;
}

function boundedBytes(value: string, name: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") > maximum) throw new Error(`${name} cannot exceed ${maximum} bytes`);
  return value;
}

export function loadDocuSignConfig(environment: DocuSignEnvironment): DocuSignConfig {
  const baseUri = new URL(required(environment.DOCUSIGN_BASE_URI, "DOCUSIGN_BASE_URI"));
  if (baseUri.protocol !== "https:" || baseUri.username || baseUri.password || baseUri.search || baseUri.hash) {
    throw new Error("DOCUSIGN_BASE_URI must be a credential-free HTTPS URL");
  }
  if (!API_HOSTS.has(baseUri.hostname) || baseUri.port || baseUri.pathname !== "/") {
    throw new Error("DOCUSIGN_BASE_URI must be an approved DocuSign API origin");
  }
  const rsaPrivateKey = required(environment.DOCUSIGN_RSA_PRIVATE_KEY, "DOCUSIGN_RSA_PRIVATE_KEY")
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n");
  try {
    const key = createPrivateKey(rsaPrivateKey);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error("weak key");
    }
  } catch {
    throw new Error("DOCUSIGN_RSA_PRIVATE_KEY must be an RSA private key of at least 2048 bits");
  }
  const webhookSecrets = [
    environment.DOCUSIGN_CONNECT_HMAC_SECRET,
    environment.DOCUSIGN_CONNECT_HMAC_SECRET_2,
  ].filter((secret): secret is string => Boolean(secret?.trim())).map((secret) =>
    boundedBytes(secret.trim(), "DocuSign webhook secret", MAX_WEBHOOK_SECRET_BYTES));
  if (webhookSecrets.length === 0) throw new Error("at least one DocuSign webhook secret is required");
  return {
    userId: bounded(required(environment.DOCUSIGN_USER_ID, "DOCUSIGN_USER_ID"), "DOCUSIGN_USER_ID", 128),
    accountId: bounded(required(environment.DOCUSIGN_ACCOUNT_ID, "DOCUSIGN_ACCOUNT_ID"), "DOCUSIGN_ACCOUNT_ID", 128),
    integrationKey: bounded(
      required(environment.DOCUSIGN_INTEGRATION_KEY, "DOCUSIGN_INTEGRATION_KEY"),
      "DOCUSIGN_INTEGRATION_KEY",
      128,
    ),
    baseUri: baseUri.toString().replace(/\/$/, ""),
    rsaPrivateKey,
    webhookSecrets,
  };
}

export interface TemplateRole {
  readonly roleName: string;
  readonly name: string;
  readonly email: string;
}

export interface CreateEnvelopeInput {
  readonly templateId: string;
  readonly templateRoles: readonly TemplateRole[];
  readonly status: "created" | "sent";
  readonly emailSubject?: string;
  readonly idempotencyKey: string;
}

export interface EnvelopeStatus {
  readonly envelopeId: string;
  readonly status: "created" | "sent" | "delivered" | "completed" | "declined" | "voided" | "deleted";
  readonly completedDateTime?: string;
  readonly voidedReason?: string;
}

export interface DocuSignClientOptions {
  readonly config: DocuSignConfig;
  readonly idempotencyStore: EnvelopeIdempotencyStore;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface EnvelopeIdempotencyStore {
  readonly reserve: (
    scope: string,
    key: string,
    requestHash: string,
    create: () => Promise<{ envelopeId: string; status: string }>,
  ) => Promise<{ envelopeId: string; status: string }>;
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("now must return a non-negative safe integer");
  return value;
}

const API_HOSTS = new Set([
  "demo.docusign.net",
  "www.docusign.net",
  "na1.docusign.net",
  "na2.docusign.net",
  "na3.docusign.net",
  "na4.docusign.net",
  "eu.docusign.net",
  "eu1.docusign.net",
  "eu2.docusign.net",
  "au.docusign.net",
  "ca.docusign.net",
]);
const AUTH_HOST_BY_API_HOST: Readonly<Record<string, string>> = {
  "demo.docusign.net": "account-d.docusign.com",
  "www.docusign.net": "account.docusign.com",
  "na1.docusign.net": "account.docusign.com",
  "na2.docusign.net": "account.docusign.com",
  "na3.docusign.net": "account.docusign.com",
  "na4.docusign.net": "account.docusign.com",
  "eu.docusign.net": "account.docusign.com",
  "eu1.docusign.net": "account.docusign.com",
  "eu2.docusign.net": "account.docusign.com",
  "au.docusign.net": "account.docusign.com",
  "ca.docusign.net": "account.docusign.com",
};
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_WEBHOOK_BYTES = 1_000_000;
const MAX_WEBHOOK_SECRETS = 4;
const MAX_WEBHOOK_SECRET_BYTES = 512;

export class DocuSignClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private accessToken?: string;
  private expiresAt = 0;
  private tokenInFlight?: Promise<string>;

  public constructor(private readonly options: DocuSignClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new Error("timeoutMs must be an integer from 1 to 120000");
    }
    safeNow(this.now);
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await deadline(
        this.fetcher(url, { ...init, signal: controller.signal }),
        this.timeoutMs,
        "DocuSign request timed out",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async token(): Promise<string> {
    if (this.accessToken && safeNow(this.now) < this.expiresAt - 120_000) return this.accessToken;
    if (!this.tokenInFlight) {
      this.tokenInFlight = this.requestToken().finally(() => {
        this.tokenInFlight = undefined;
      });
    }
    return this.tokenInFlight;
  }

  private async requestToken(): Promise<string> {
    const now = safeNow(this.now);
    const issuedAt = Math.floor(now / 1000);
    const audience = AUTH_HOST_BY_API_HOST[new URL(this.options.config.baseUri).hostname];
    if (!audience) throw new Error("DocuSign API host has no approved authorization host");
    const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const encodedClaims = base64Url(JSON.stringify({
      iss: this.options.config.integrationKey,
      sub: this.options.config.userId,
      aud: audience,
      scope: "signature impersonation",
      iat: issuedAt,
      exp: issuedAt + 3600,
    }));
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    const assertion = `${signingInput}.${base64Url(sign("RSA-SHA256", Buffer.from(signingInput), this.options.config.rsaPrivateKey))}`;
    const response = await this.fetch(`https://${audience}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) throw await providerError(response, this.timeoutMs);
    const payload = await responseJson(response, this.timeoutMs);
    if (!isRecord(payload) || typeof payload.access_token !== "string" || !Number.isSafeInteger(payload.expires_in)) {
      throw new Error("DocuSign token response was malformed");
    }
    const expiresIn = payload.expires_in as number;
    if (expiresIn < 1) throw new Error("DocuSign token expiry was invalid");
    this.accessToken = required(payload.access_token, "access_token");
    const expiresAt = now + expiresIn * 1000;
    if (!Number.isSafeInteger(expiresAt)) throw new Error("DocuSign token expiry was invalid");
    this.expiresAt = expiresAt;
    return this.accessToken;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.options.config.baseUri}/restapi/v2.1/accounts/${encodeURIComponent(this.options.config.accountId)}${path}`;
    const send = async (token: string): Promise<Response> => this.fetch(url, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${token}` },
    });
    const firstToken = await this.token();
    let response = await send(firstToken);
    if (response.status === 401) {
      await discardResponse(response);
      if (this.accessToken === firstToken) {
        this.accessToken = undefined;
        this.expiresAt = 0;
      }
      response = await send(await this.token());
    }
    if (!response.ok) throw await providerError(response, this.timeoutMs);
    return response;
  }

  public async createEnvelopeFromTemplate(input: CreateEnvelopeInput): Promise<{ envelopeId: string; status: string }> {
    required(input.templateId, "templateId");
    if (!Array.isArray(input.templateRoles) || input.templateRoles.length < 1 || input.templateRoles.length > 100) {
      throw new Error("templateRoles must contain 1 to 100 roles");
    }
    const templateRoles = input.templateRoles.map((role) => ({
      roleName: bounded(required(role?.roleName, "roleName"), "roleName", 100),
      name: bounded(required(role?.name, "name"), "name", 100),
      email: validateEmail(role?.email),
    }));
    if (input.status !== "created" && input.status !== "sent") throw new Error("status must be created or sent");
    const emailSubject = input.emailSubject === undefined
      ? undefined
      : bounded(required(input.emailSubject, "emailSubject"), "emailSubject", 100);
    const idempotencyKey = bounded(required(input.idempotencyKey, "idempotencyKey"), "idempotencyKey", 100);
    const requestBody = {
      templateId: bounded(input.templateId, "templateId", 128),
      templateRoles,
      status: input.status,
      ...(emailSubject ? { emailSubject } : {}),
    };
    const scope = `${this.options.config.userId}:${this.options.config.accountId}`;
    const requestHash = createHash("sha256").update(JSON.stringify({ scope, requestBody })).digest("hex");
    const result = await this.options.idempotencyStore.reserve(scope, idempotencyKey, requestHash, async () => {
      const response = await this.request("/envelopes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-docusign-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      });
      return parseEnvelopeResult(await responseJson(response, this.timeoutMs), "create-envelope");
    });
    return parseEnvelopeResult(result, "idempotency store");
  }

  public async getEnvelopeStatus(envelopeId: string): Promise<EnvelopeStatus> {
    const requestedEnvelopeId = bounded(required(envelopeId, "envelopeId"), "envelopeId", 128);
    const response = await this.request(`/envelopes/${encodeURIComponent(requestedEnvelopeId)}`, {
      method: "GET",
    });
    const payload = await responseJson(response, this.timeoutMs);
    if (!isRecord(payload) || typeof payload.envelopeId !== "string" || !isEnvelopeStatus(payload.status)) {
      throw new Error("DocuSign envelope response was malformed");
    }
    if (payload.envelopeId !== requestedEnvelopeId) {
      throw new Error("DocuSign envelope response did not match the requested envelope");
    }
    return {
      envelopeId: payload.envelopeId,
      status: payload.status,
      ...(typeof payload.completedDateTime === "string" ? { completedDateTime: payload.completedDateTime } : {}),
      ...(typeof payload.voidedReason === "string" ? { voidedReason: payload.voidedReason } : {}),
    };
  }

  public async voidEnvelope(envelopeId: string, reason: string): Promise<void> {
    const response = await this.request(`/envelopes/${encodeURIComponent(bounded(required(envelopeId, "envelopeId"), "envelopeId", 128))}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "voided", voidedReason: bounded(required(reason, "voidReason"), "voidReason", 500) }),
    });
    await discardResponse(response);
  }
}

function parseEnvelopeResult(value: unknown, source: string): { envelopeId: string; status: EnvelopeStatus["status"] } {
  if (!isRecord(value) || typeof value.envelopeId !== "string" || !isEnvelopeStatus(value.status)) {
    throw new Error(`DocuSign ${source} response was malformed`);
  }
  return { envelopeId: bounded(required(value.envelopeId, "envelopeId"), "envelopeId", 128), status: value.status };
}

function validateEmail(value: string): string {
  const email = bounded(required(value, "email"), "email", 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email is invalid");
  return email;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvelopeStatus(value: unknown): value is EnvelopeStatus["status"] {
  return ["created", "sent", "delivered", "completed", "declined", "voided", "deleted"].includes(String(value));
}

async function providerError(response: Response, timeoutMs: number): Promise<Error> {
  return new Error(`DocuSign request failed (${response.status}): ${(await responseText(response, timeoutMs)).slice(0, 500)}`);
}

async function responseText(response: Response, timeoutMs: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    cancelBestEffort(() => response.body!.cancel());
    throw new Error("DocuSign response exceeded the size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await deadline(reader.read(), timeoutMs, "DocuSign response body timed out");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("DocuSign response exceeded the size limit");
      chunks.push(chunk.value);
    }
  } catch (error) {
    cancelBestEffort(() => reader.cancel());
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function responseJson(response: Response, timeoutMs: number): Promise<Record<string, unknown>> {
  const text = await responseText(response, timeoutMs);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("DocuSign response was not valid JSON");
  }
  if (!isRecord(payload)) throw new Error("DocuSign response was malformed");
  return payload;
}

async function discardResponse(response: Response): Promise<void> {
  if (response.body) cancelBestEffort(() => response.body!.cancel());
}

function cancelBestEffort(cancel: () => Promise<void>): void {
  try {
    void cancel().catch(() => undefined);
  } catch {
    // Cancellation is cleanup only; request deadlines and primary errors must still settle.
  }
}

export function verifyDocuSignWebhook(rawBody: Uint8Array, signature: string | undefined, secrets: readonly string[]): boolean {
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength > MAX_WEBHOOK_BYTES) return false;
  if (!Array.isArray(secrets) || secrets.length === 0 || secrets.length > MAX_WEBHOOK_SECRETS) return false;
  if (!secrets.every((secret) => typeof secret === "string" && secret.length > 0 &&
      Buffer.byteLength(secret, "utf8") <= MAX_WEBHOOK_SECRET_BYTES)) return false;
  if (!signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const supplied = Buffer.from(signature, "base64");
  if (supplied.toString("base64") !== signature) return false;
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    matched = (supplied.length === expected.length && timingSafeEqual(supplied, expected)) || matched;
  }
  return matched;
}

export type SellerStatus = "onboarding_initiated" | "listing_docs_signed" | "disclosures_signed" | "fully_onboarded";
export type EnvelopeKind = "listing" | "disclosure";

export function deriveSellerStatus(current: SellerStatus, completed: EnvelopeKind): SellerStatus {
  if (current === "fully_onboarded") return current;
  if (completed === "listing") return current === "disclosures_signed" ? "fully_onboarded" : "listing_docs_signed";
  return current === "listing_docs_signed" ? "fully_onboarded" : "disclosures_signed";
}

export interface WebhookTransitionStore {
  /** Atomically deduplicates eventKey and derives owner, kind, and update from the persisted envelope. */
  readonly applyOnce: (
    eventKey: string,
    envelopeId: string,
    transition: (persisted: PersistedEnvelope) => SellerStatus,
  ) => Promise<{ readonly applied: boolean; readonly ownerId: string; readonly status: SellerStatus }>;
}

export interface PersistedEnvelope {
  readonly envelopeId: string;
  readonly ownerId: string;
  readonly kind: EnvelopeKind;
  readonly status: SellerStatus;
}

export async function processDocuSignWebhook(
  rawBody: Uint8Array,
  signature: string | undefined,
  secrets: readonly string[],
  store: WebhookTransitionStore,
): Promise<{ applied: boolean; ownerId: string; status: SellerStatus }> {
  if (!verifyDocuSignWebhook(rawBody, signature, secrets)) throw new Error("invalid DocuSign webhook signature");
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    throw new Error("DocuSign webhook body must be valid UTF-8");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("DocuSign webhook body must be valid JSON");
  }
  if (!isRecord(payload) || payload.event !== "envelope-completed" || typeof payload.generatedDateTime !== "string" ||
      !isRecord(payload.data) || typeof payload.data.envelopeId !== "string") {
    throw new Error("DocuSign webhook payload was malformed or unsupported");
  }
  const envelopeId = bounded(required(payload.data.envelopeId, "envelopeId"), "envelopeId", 128);
  const eventKey = `${envelopeId}:envelope-completed:${bounded(payload.generatedDateTime, "generatedDateTime", 64)}`;
  let persistedOwnerId: string | undefined;
  let derivedStatus: SellerStatus | undefined;
  const result = await store.applyOnce(eventKey, envelopeId, (persisted) => {
    if (!isPersistedEnvelope(persisted) || persisted.envelopeId !== envelopeId) {
      throw new Error("persisted DocuSign envelope was malformed");
    }
    persistedOwnerId = persisted.ownerId;
    derivedStatus = deriveSellerStatus(persisted.status, persisted.kind);
    return derivedStatus;
  });
  if (!isRecord(result) || typeof result.applied !== "boolean" || typeof result.ownerId !== "string" ||
      !result.ownerId.trim() || !isSellerStatus(result.status)) {
    throw new Error("DocuSign webhook store result was malformed");
  }
  if (persistedOwnerId === undefined || result.ownerId !== persistedOwnerId) {
    throw new Error("DocuSign webhook store returned a mismatched envelope owner");
  }
  if (derivedStatus === undefined || result.status !== derivedStatus) {
    throw new Error("DocuSign webhook store returned a mismatched derived status");
  }
  return { applied: result.applied, ownerId: result.ownerId, status: result.status };
}

function isSellerStatus(value: unknown): value is SellerStatus {
  return ["onboarding_initiated", "listing_docs_signed", "disclosures_signed", "fully_onboarded"].includes(String(value));
}

function isPersistedEnvelope(value: unknown): value is PersistedEnvelope {
  return isRecord(value) && typeof value.envelopeId === "string" && typeof value.ownerId === "string" &&
    value.ownerId.trim().length > 0 && (value.kind === "listing" || value.kind === "disclosure") &&
    isSellerStatus(value.status);
}

async function deadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
