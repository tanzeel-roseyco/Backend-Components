import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface StripeLineItem {
  readonly name: string;
  readonly unitAmountMinor: number;
  readonly quantity: number;
}

export interface StripeCheckoutInput {
  readonly tenantId: string;
  readonly merchantId: string;
  readonly orderId: string;
  readonly idempotencyKey: string;
  readonly currency: string;
  readonly lines: readonly StripeLineItem[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface StripeCheckout {
  readonly sessionId: string;
  readonly url: string;
  readonly requestHash: string;
  readonly requestVersion: number;
}

export type CheckoutReservation =
  | { readonly status: "reserved" | "resume"; readonly requestHash: string; readonly requestVersion: number }
  | { readonly status: "completed"; readonly checkout: StripeCheckout }
  | { readonly status: "conflict" };

export interface StripeCheckoutStore {
  /** Atomically reserves tenant + merchant + idempotencyKey and rejects a different requestHash. */
  begin(input: {
    readonly merchantId: string;
    readonly tenantId: string;
    readonly orderId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly requestVersion: number;
  }, signal: AbortSignal): Promise<CheckoutReservation>;
  /** Atomically persists the replayable provider result for the reservation. */
  complete(input: {
    readonly merchantId: string;
    readonly tenantId: string;
    readonly orderId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly requestVersion: number;
    readonly checkout: StripeCheckout;
  }, signal: AbortSignal): Promise<StripeCheckout>;
}

export interface StripeCheckoutProvider {
  /** Repeated calls with the same providerIdempotencyKey must return the same session. */
  createCheckout(
    input: Omit<StripeCheckoutInput, "idempotencyKey">,
    providerIdempotencyKey: string,
    signal: AbortSignal
  ): Promise<{ readonly sessionId: string; readonly url: string }>;
}

export type PaymentStatus = "paid" | "partially_refunded" | "refunded";

export interface PersistedPaymentState {
  readonly tenantId: string;
  readonly merchantId: string;
  readonly orderId: string;
  readonly status: PaymentStatus;
  readonly currency: string;
  readonly paidAmountMinor: number;
  readonly refundedAmountMinor: number;
  readonly stateVersion: number;
  readonly checkoutSessionId: string;
  readonly paymentIntentId: string;
  readonly latestChargeId?: string;
}

export type StripePaymentTransition =
  | {
      readonly kind: "paid";
      readonly tenantId: string;
      readonly merchantId: string;
      readonly orderId: string;
      readonly currency: string;
      readonly paidAmountMinor: number;
      readonly checkoutSessionId: string;
      readonly paymentIntentId: string;
    }
  | {
      readonly kind: "refund";
      readonly tenantId: string;
      readonly merchantId: string;
      readonly orderId: string;
      readonly currency: string;
      readonly paidAmountMinor: number;
      readonly refundedAmountMinor: number;
      readonly paymentIntentId: string;
      readonly chargeId: string;
    };

export interface StripePaymentTransitionStore {
  /**
   * Atomically deduplicates eventId + eventHash and applies cumulative refunds
   * monotonically. Equal cumulative amounts are idempotent; lower amounts must
   * conflict without changing state. expectedCheckoutSessionId is read from the
   * same locked payment record and binds refund results to immutable lineage.
   */
  applyEventOnce(input: {
    readonly eventId: string;
    readonly eventHash: string;
    readonly transition: StripePaymentTransition;
    readonly stateVersion: number;
  }, signal: AbortSignal): Promise<{
    readonly applied: boolean;
    readonly eventId: string;
    readonly eventHash: string;
    readonly state: PersistedPaymentState;
    readonly expectedCheckoutSessionId: string;
  }>;
}

export interface StripeWebhookOptions {
  readonly secrets: readonly string[];
  readonly store: StripePaymentTransitionStore;
  readonly now?: () => number;
  readonly toleranceSeconds?: number;
  readonly maxBodyBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface StripeOperationOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const MAX_LINES = 100;
const MAX_QUANTITY = 999;
const MAX_UNIT_AMOUNT_MINOR = 100_000_000;
const MAX_TOTAL_AMOUNT_MINOR = 1_000_000_000_000;
const MAX_METADATA_KEYS = 50;
const MAX_METADATA_KEY_CHARS = 40;
const MAX_METADATA_VALUE_CHARS = 500;
const MAX_IDENTIFIER_CHARS = 128;
const MAX_NAME_CHARS = 200;
const MAX_URL_CHARS = 2_048;
const DEFAULT_WEBHOOK_BYTES = 1024 * 1024;
const MAX_WEBHOOK_BYTES = 4 * 1024 * 1024;
const DEFAULT_TOLERANCE_SECONDS = 300;
const MAX_SIGNATURE_HEADER_CHARS = 2_048;
const REQUEST_VERSION = 1;
const PAYMENT_STATE_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const STRIPE_CHECKOUT_ORIGINS = new Set(["https://checkout.stripe.com"]);

function bounded(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
  if (value.length > maximum) throw new RangeError(`${name} cannot exceed ${maximum} characters`);
  return value;
}

function identifier(value: unknown, name: string): string {
  const result = bounded(value, name, MAX_IDENTIFIER_CHARS).trim();
  if (/[\u0000-\u001f\u007f]/.test(result)) throw new TypeError(`${name} contains control characters`);
  return result;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function exactCurrency(value: unknown): string {
  const currency = bounded(value, "currency", 3).toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new TypeError("currency must be a three-letter code");
  return currency;
}

function safeUrl(value: unknown, name: string): string {
  const raw = bounded(value, name, MAX_URL_CHARS);
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError(`${name} must be a credential-free HTTPS URL without a fragment`);
  }
  return url.toString();
}

function stripeCheckoutUrl(value: unknown): string {
  const url = new URL(safeUrl(value, "provider checkout url"));
  if (!STRIPE_CHECKOUT_ORIGINS.has(url.origin)) {
    throw new TypeError("provider checkout url must use an approved Stripe Checkout origin");
  }
  return url.toString();
}

function deadline(options: StripeOperationOptions): {
  signal: AbortSignal;
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  close(): void;
} {
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    MAX_TIMEOUT_MS
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (controller.signal.aborted) return Promise.reject(new Error("Stripe operation timed out or was aborted"));
      return new Promise<T>((resolve, reject) => {
        const rejectAbort = () => reject(new Error("Stripe operation timed out or was aborted"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
        Promise.resolve().then(() => operation(controller.signal)).then(resolve, reject).finally(
          () => controller.signal.removeEventListener("abort", rejectAbort)
        );
      });
    },
    close(): void {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    },
  };
}

function metadataSnapshot(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("metadata must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_KEYS) throw new RangeError(`metadata cannot exceed ${MAX_METADATA_KEYS} keys`);
  const output: Record<string, string> = {};
  for (const [key, item] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    bounded(key, "metadata key", MAX_METADATA_KEY_CHARS);
    const metadataValue = bounded(item, `metadata.${key}`, MAX_METADATA_VALUE_CHARS);
    if (/[\u0000-\u001f\u007f]/.test(key + metadataValue)) {
      throw new TypeError("metadata cannot contain control characters");
    }
    output[key] = metadataValue;
  }
  return Object.freeze(output);
}

function checkoutSnapshot(input: StripeCheckoutInput): StripeCheckoutInput {
  const tenantId = identifier(input?.tenantId, "tenantId");
  const merchantId = identifier(input?.merchantId, "merchantId");
  const orderId = identifier(input?.orderId, "orderId");
  const idempotencyKey = identifier(input?.idempotencyKey, "idempotencyKey");
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > MAX_LINES) {
    throw new RangeError(`lines must contain 1 to ${MAX_LINES} items`);
  }
  let total = 0n;
  const lines = input.lines.map((line, index) => {
    const unitAmountMinor = positiveInteger(
      line?.unitAmountMinor,
      `lines[${index}].unitAmountMinor`,
      MAX_UNIT_AMOUNT_MINOR
    );
    const quantity = positiveInteger(line?.quantity, `lines[${index}].quantity`, MAX_QUANTITY);
    total += BigInt(unitAmountMinor) * BigInt(quantity);
    return Object.freeze({
      name: bounded(line?.name, `lines[${index}].name`, MAX_NAME_CHARS),
      unitAmountMinor,
      quantity,
    });
  });
  if (total > BigInt(MAX_TOTAL_AMOUNT_MINOR)) {
    throw new RangeError(`checkout total cannot exceed ${MAX_TOTAL_AMOUNT_MINOR}`);
  }
  const callerMetadata = metadataSnapshot(input.metadata);
  if (
    Object.hasOwn(callerMetadata, "merchant_id") ||
    Object.hasOwn(callerMetadata, "tenant_id") ||
    Object.hasOwn(callerMetadata, "order_id") ||
    Object.keys(callerMetadata).length > MAX_METADATA_KEYS - 3
  ) {
    throw new RangeError("metadata reserves tenant_id, merchant_id, and order_id and cannot exceed 47 caller keys");
  }
  // Persist correlation IDs in Stripe itself so webhook transitions never trust ambient context.
  const metadata = Object.freeze(Object.fromEntries([
    ...Object.entries(callerMetadata),
    ["merchant_id", merchantId],
    ["order_id", orderId],
    ["tenant_id", tenantId],
  ].sort(([a], [b]) => a.localeCompare(b))));
  return Object.freeze({
    tenantId,
    merchantId,
    orderId,
    idempotencyKey,
    currency: exactCurrency(input.currency),
    lines: Object.freeze(lines),
    metadata,
    successUrl: safeUrl(input.successUrl, "successUrl"),
    cancelUrl: safeUrl(input.cancelUrl, "cancelUrl"),
  });
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function createStripeCheckout(
  store: StripeCheckoutStore,
  provider: StripeCheckoutProvider,
  input: StripeCheckoutInput,
  options: StripeOperationOptions = {}
): Promise<StripeCheckout> {
  const snapshot = checkoutSnapshot(input);
  const requestHash = hashJson(snapshot);
  const operation = deadline(options);
  try {
    const reservation = await operation.run((signal) => store.begin({
      tenantId: snapshot.tenantId,
      merchantId: snapshot.merchantId,
      orderId: snapshot.orderId,
      idempotencyKey: snapshot.idempotencyKey,
      requestHash,
      requestVersion: REQUEST_VERSION,
    }, signal));
    if (!reservation || typeof reservation !== "object") throw new Error("checkout store returned an invalid reservation");
    if (reservation.status === "conflict") throw new Error("checkout idempotency key conflicts with another request");
    if (reservation.status === "completed") {
      if (
        reservation.checkout?.requestHash !== requestHash ||
        reservation.checkout?.requestVersion !== REQUEST_VERSION
      ) throw new Error("stored checkout conflicts with this request");
      return Object.freeze({
        sessionId: identifier(reservation.checkout.sessionId, "stored sessionId"),
        url: stripeCheckoutUrl(reservation.checkout.url),
        requestHash,
        requestVersion: REQUEST_VERSION,
      });
    }
    if (
      (reservation.status !== "reserved" && reservation.status !== "resume") ||
      reservation.requestHash !== requestHash ||
      reservation.requestVersion !== REQUEST_VERSION
    ) {
      throw new Error("checkout store returned an invalid reservation state");
    }
    const providerKey = hashJson([
      snapshot.tenantId,
      snapshot.merchantId,
      snapshot.orderId,
      snapshot.idempotencyKey,
      requestHash,
      REQUEST_VERSION,
    ]);
    const { idempotencyKey: _omitted, ...providerInput } = snapshot;
    void _omitted;
    const created = await operation.run(
      (signal) => provider.createCheckout(providerInput, providerKey, signal)
    );
    const checkout = Object.freeze({
      sessionId: identifier(created?.sessionId, "provider sessionId"),
      url: stripeCheckoutUrl(created?.url),
      requestHash,
      requestVersion: REQUEST_VERSION,
    });
    const persisted = await operation.run((signal) => store.complete({
      tenantId: snapshot.tenantId,
      merchantId: snapshot.merchantId,
      orderId: snapshot.orderId,
      idempotencyKey: snapshot.idempotencyKey,
      requestHash,
      requestVersion: REQUEST_VERSION,
      checkout,
    }, signal));
    if (
      persisted?.sessionId !== checkout.sessionId ||
      persisted?.url !== checkout.url ||
      persisted?.requestHash !== requestHash ||
      persisted?.requestVersion !== REQUEST_VERSION
    ) {
      throw new Error("checkout store persisted a conflicting result");
    }
    return persisted;
  } finally {
    operation.close();
  }
}

function verifySignature(
  rawBody: Uint8Array,
  signatureHeader: string,
  secrets: readonly string[],
  nowMs: number,
  toleranceSeconds: number
): number {
  if (signatureHeader.length > MAX_SIGNATURE_HEADER_CHARS) throw new Error("Stripe signature header is too long");
  const timestamps: number[] = [];
  const signatures: Buffer[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && /^\d+$/.test(value ?? "")) timestamps.push(Number(value));
    if (key === "v1" && /^[a-f0-9]{64}$/i.test(value ?? "")) signatures.push(Buffer.from(value, "hex"));
  }
  if (timestamps.length !== 1 || signatures.length === 0) throw new Error("Stripe signature header is malformed");
  const timestamp = positiveInteger(timestamps[0], "Stripe signature timestamp", Number.MAX_SAFE_INTEGER);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new Error("Stripe webhook timestamp is outside tolerance");
  }
  let matched = false;
  for (const secret of secrets) {
    const safeSecret = bounded(secret, "Stripe webhook secret", 256);
    const expected = createHmac("sha256", safeSecret)
      .update(`${timestamp}.`, "utf8")
      .update(rawBody)
      .digest();
    for (const supplied of signatures) {
      matched = timingSafeEqual(expected, supplied) || matched;
    }
  }
  if (!matched) throw new Error("Stripe webhook signature is invalid");
  return timestamp;
}

function paymentTransition(event: Record<string, unknown>): {
  eventId: string;
  transition: StripePaymentTransition;
} {
  const eventId = identifier(event.id, "event.id");
  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("event.data must be an object");
  const object = (data as Record<string, unknown>).object;
  if (typeof object !== "object" || object === null || Array.isArray(object)) {
    throw new Error("event.data.object must be an object");
  }
  const value = object as Record<string, unknown>;
  const metadata = value.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("Stripe object metadata is required");
  }
  const tenantId = identifier((metadata as Record<string, unknown>).tenant_id, "metadata.tenant_id");
  const merchantId = identifier((metadata as Record<string, unknown>).merchant_id, "metadata.merchant_id");
  const orderId = identifier((metadata as Record<string, unknown>).order_id, "metadata.order_id");
  const providerObjectId = identifier(value.id, "provider object id");
  const currency = exactCurrency(value.currency);
  if (event.type === "checkout.session.completed") {
    if (value.payment_status !== "paid") throw new Error("completed checkout is not evidenced as paid");
    const paidAmountMinor = positiveInteger(value.amount_total as number, "amount_total", MAX_TOTAL_AMOUNT_MINOR);
    return {
      eventId,
      transition: {
        kind: "paid",
        tenantId,
        merchantId,
        orderId,
        currency,
        paidAmountMinor,
        checkoutSessionId: providerObjectId,
        paymentIntentId: identifier(value.payment_intent, "payment_intent"),
      },
    };
  }
  if (event.type === "charge.refunded") {
    const paidAmountMinor = positiveInteger(value.amount as number, "charge.amount", MAX_TOTAL_AMOUNT_MINOR);
    const refundedAmountMinor = positiveInteger(
      value.amount_refunded as number,
      "charge.amount_refunded",
      paidAmountMinor
    );
    return {
      eventId,
      transition: {
        kind: "refund",
        tenantId,
        merchantId,
        orderId,
        currency,
        paidAmountMinor,
        refundedAmountMinor,
        paymentIntentId: identifier(value.payment_intent, "payment_intent"),
        chargeId: providerObjectId,
      },
    };
  }
  throw new Error("Stripe event type is unsupported");
}

export async function processStripeWebhook(
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
  options: StripeWebhookOptions
): Promise<{ applied: boolean; state: PersistedPaymentState }> {
  if (!(rawBody instanceof Uint8Array)) throw new TypeError("rawBody must be exact bytes");
  const maxBodyBytes = positiveInteger(
    options.maxBodyBytes ?? DEFAULT_WEBHOOK_BYTES,
    "maxBodyBytes",
    MAX_WEBHOOK_BYTES
  );
  if (rawBody.byteLength > maxBodyBytes) throw new RangeError(`Stripe webhook cannot exceed ${maxBodyBytes} bytes`);
  if (!signatureHeader) throw new Error("Stripe signature header is required");
  if (!Array.isArray(options.secrets) || options.secrets.length < 1 || options.secrets.length > 4) {
    throw new Error("Stripe webhook secrets must contain 1 to 4 values");
  }
  const toleranceSeconds = positiveInteger(
    options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS,
    "toleranceSeconds",
    3_600
  );
  const operation = deadline(options);
  try {
    if (operation.signal.aborted) throw new Error("Stripe operation timed out or was aborted");
    const now = (options.now ?? Date.now)();
    verifySignature(rawBody, signatureHeader, options.secrets, now, toleranceSeconds);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    } catch {
      throw new Error("Stripe webhook must be valid UTF-8 JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Stripe webhook must be an object");
    }
    if (operation.signal.aborted) throw new Error("Stripe operation timed out or was aborted");
    const { eventId, transition } = paymentTransition(parsed as Record<string, unknown>);
    const eventHash = createHash("sha256").update(rawBody).digest("hex");
    const result = await operation.run((signal) => options.store.applyEventOnce({
      eventId,
      eventHash,
      transition,
      stateVersion: PAYMENT_STATE_VERSION,
    }, signal));
    if (
      !result ||
      typeof result.applied !== "boolean" ||
      result.eventId !== eventId ||
      result.eventHash !== eventHash ||
      typeof result.expectedCheckoutSessionId !== "string"
    ) {
      throw new Error("payment transition store returned an invalid state");
    }
    validatePersistedState(
      result.state,
      transition,
      result.expectedCheckoutSessionId,
      result.applied
    );
    return { applied: result.applied, state: result.state };
  } finally {
    operation.close();
  }
}

function validatePersistedState(
  value: PersistedPaymentState,
  transition: StripePaymentTransition,
  expectedCheckoutSessionId: string,
  applied: boolean
): PersistedPaymentState {
  if (!value || !["paid", "partially_refunded", "refunded"].includes(value.status)) {
    throw new Error("payment transition store returned an invalid state");
  }
  if (
    value.stateVersion !== PAYMENT_STATE_VERSION ||
    value.tenantId !== transition.tenantId ||
    value.merchantId !== transition.merchantId ||
    value.orderId !== transition.orderId ||
    value.currency !== transition.currency ||
    value.paidAmountMinor !== transition.paidAmountMinor ||
    value.paymentIntentId !== transition.paymentIntentId
  ) throw new Error("payment transition store changed immutable payment evidence");
  identifier(value.tenantId, "persisted tenantId");
  identifier(value.merchantId, "persisted merchantId");
  identifier(value.orderId, "persisted orderId");
  identifier(value.checkoutSessionId, "persisted checkoutSessionId");
  identifier(expectedCheckoutSessionId, "expected checkoutSessionId");
  identifier(value.paymentIntentId, "persisted paymentIntentId");
  if (value.latestChargeId !== undefined) identifier(value.latestChargeId, "persisted latestChargeId");
  exactCurrency(value.currency);
  positiveInteger(value.paidAmountMinor, "persisted paidAmountMinor", MAX_TOTAL_AMOUNT_MINOR);
  if (!Number.isSafeInteger(value.refundedAmountMinor) || value.refundedAmountMinor < 0 ||
      value.refundedAmountMinor > value.paidAmountMinor) {
    throw new Error("persisted refundedAmountMinor is invalid");
  }
  if (
    (value.status === "paid" && value.refundedAmountMinor !== 0) ||
    (value.status === "partially_refunded" &&
      (value.refundedAmountMinor === 0 || value.refundedAmountMinor === value.paidAmountMinor)) ||
    (value.status === "refunded" && value.refundedAmountMinor !== value.paidAmountMinor)
  ) {
    throw new Error("persisted payment status does not match refund evidence");
  }
  if (
    value.checkoutSessionId !== expectedCheckoutSessionId ||
    (transition.kind === "paid" && expectedCheckoutSessionId !== transition.checkoutSessionId) ||
    (transition.kind === "refund" && applied &&
      (value.latestChargeId !== transition.chargeId ||
        value.refundedAmountMinor !== transition.refundedAmountMinor)) ||
    (transition.kind === "refund" && !applied &&
      value.refundedAmountMinor < transition.refundedAmountMinor)
  ) throw new Error("payment transition store changed provider lineage");
  return value;
}
