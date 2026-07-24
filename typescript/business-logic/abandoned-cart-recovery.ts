import { createHash } from "node:crypto";

export interface CartLine {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
}

export interface RecoveryMessage {
  readonly tenantId: string;
  readonly cartId: string;
  readonly sequence: number;
  readonly email: string;
  readonly checkoutUrl: string;
  readonly currency: string;
  readonly lines: readonly CartLine[];
  readonly totalMinor: number;
}

export interface ClaimedAbandonedCart {
  readonly tenantId: string;
  readonly cartId: string;
  readonly sequence: number;
  readonly leaseToken: string;
  readonly fence: number;
  readonly attempts: number;
  readonly lastActivityAt: Date;
  readonly checkoutUrl: string;
  readonly customerEmail: string;
  readonly currency: string;
  readonly lines: readonly CartLine[];
}

export interface RecoveryLease {
  readonly tenantId: string;
  readonly cartId: string;
  readonly sequence: number;
  readonly leaseToken: string;
  readonly fence: number;
}

export interface AbandonedCartRecoveryStore {
  listEligible(
    tenantId: string,
    inactiveBefore: Date,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly { cartId: string; sequence: number }[]>;
  claim(input: {
    tenantId: string;
    cartId: string;
    sequence: number;
    now: Date;
    leaseMs: number;
    maxAttempts: number;
    signal: AbortSignal;
  }): Promise<ClaimedAbandonedCart | null>;
  renew(lease: RecoveryLease, now: Date, leaseMs: number, signal: AbortSignal): Promise<Date | null>;
  /**
   * Atomically rechecks current consent and suppression, then persists the
   * immutable outbox snapshot. The cart sequence is the idempotency boundary:
   * equal hashes replay the persisted outbox and different hashes conflict.
   */
  authorizeDispatch(input: {
    lease: RecoveryLease;
    requestHash: string;
    deliveryKey: string;
    message: RecoveryMessage;
    now: Date;
    signal: AbortSignal;
  }): Promise<
    | {
        status: "authorized";
        outcome: "created" | "replay";
        requestHash: string;
        deliveryKey: string;
        message: RecoveryMessage;
      }
    | { status: "conflict"; requestHash: string }
    | { status: "suppressed"; reason: string }
  >;
  markSent(lease: RecoveryLease, sentAt: Date, signal: AbortSignal): Promise<boolean>;
  markSuppressed(
    lease: RecoveryLease,
    reason: string,
    at: Date,
    signal: AbortSignal
  ): Promise<boolean>;
  markFailed(
    lease: RecoveryLease,
    error: string,
    retryAt: Date | null,
    signal: AbortSignal
  ): Promise<boolean>;
}

export interface RecoverySender {
  /** Repeated deliveryKey calls must return the original delivery without resending. */
  sendIdempotently(input: {
    deliveryKey: string;
    requestHash: string;
    message: RecoveryMessage;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface AbandonedCartRecoveryOptions {
  inactivityMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  maxBatchSize?: number;
  operationTimeoutMs?: number;
  retryDelayMs?: (attempts: number) => number;
  now?: () => number;
}

export interface RecoveryBatchResult {
  listed: number;
  claimed: number;
  sent: number;
  suppressed: number;
  failed: number;
  busy: number;
}

const MAX_KEY = 200;
const MAX_LINES = 100;
const MAX_TEXT = 500;
const MAX_ERROR = 500;
const MAX_RETRY_MS = 24 * 60 * 60_000;

function identifier(value: string, name: string, maximum = MAX_KEY): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const canonical = value.trim();
  if (canonical.length > maximum || /[\u0000-\u001f\u007f]/.test(canonical)) {
    throw new RangeError(`${name} is invalid`);
  }
  return canonical;
}

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`${name} is invalid`);
  return value;
}

function canonicalEmail(value: string): string {
  const email = identifier(value, "customerEmail", 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("customerEmail is invalid");
  return email;
}

function canonicalCurrency(value: string): string {
  const currency = identifier(value, "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter ISO 4217 code");
  return currency;
}

function lease(cart: ClaimedAbandonedCart): RecoveryLease {
  return {
    tenantId: cart.tenantId,
    cartId: cart.cartId,
    sequence: cart.sequence,
    leaseToken: cart.leaseToken,
    fence: cart.fence,
  };
}

function snapshot(
  cart: ClaimedAbandonedCart,
  tenantId: string,
  cartId: string,
  sequence: number,
  inactiveBefore: Date,
  maxAttempts: number
): RecoveryMessage {
  if (!cart || typeof cart !== "object") throw new Error("store returned an invalid cart");
  if (identifier(cart.tenantId, "cart tenantId") !== tenantId) throw new Error("store returned the wrong tenant");
  if (identifier(cart.cartId, "cartId") !== cartId || cart.sequence !== sequence) {
    throw new Error("store returned the wrong cart or sequence");
  }
  identifier(cart.leaseToken, "leaseToken");
  integer(cart.fence, "fence", 1, Number.MAX_SAFE_INTEGER);
  integer(cart.attempts, "attempts", 1, maxAttempts);
  if (validDate(cart.lastActivityAt, "lastActivityAt").getTime() > inactiveBefore.getTime()) {
    throw new Error("cart is not old enough for recovery");
  }
  const checkout = new URL(identifier(cart.checkoutUrl, "checkoutUrl", 2_000));
  if (checkout.protocol !== "https:" || checkout.username || checkout.password || checkout.hash) {
    throw new Error("checkoutUrl must be a credential-free HTTPS URL without a fragment");
  }
  if (!Array.isArray(cart.lines) || cart.lines.length < 1 || cart.lines.length > MAX_LINES) {
    throw new Error(`cart lines must contain 1 to ${MAX_LINES} items`);
  }

  let totalMinor = 0;
  const productIds = new Set<string>();
  const lines = cart.lines.map((line, index) => {
    if (!line || typeof line !== "object") throw new Error(`line ${index} is invalid`);
    const productId = identifier(line.productId, `line ${index} productId`);
    if (productIds.has(productId)) throw new Error(`duplicate productId: ${productId}`);
    productIds.add(productId);
    const name = identifier(line.name, `line ${index} name`, MAX_TEXT);
    const quantity = integer(line.quantity, `line ${index} quantity`, 1, 10_000);
    const unitPriceMinor = integer(line.unitPriceMinor, `line ${index} unitPriceMinor`, 0, 10_000_000_000);
    const lineTotal = quantity * unitPriceMinor;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(totalMinor + lineTotal)) {
      throw new Error("cart total exceeds safe minor-unit bounds");
    }
    totalMinor += lineTotal;
    return Object.freeze({ productId, name, quantity, unitPriceMinor });
  });
  return Object.freeze({
    tenantId,
    cartId,
    sequence,
    email: canonicalEmail(cart.customerEmail),
    checkoutUrl: checkout.toString(),
    currency: canonicalCurrency(cart.currency),
    lines: Object.freeze(lines),
    totalMinor,
  });
}

function hashMessage(message: RecoveryMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

function deliveryKey(message: RecoveryMessage, requestHash: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["abandoned-cart-recovery:v2", message.tenantId, message.cartId, message.sequence, requestHash]))
    .digest("hex");
}

class LostLeaseError extends Error {
  constructor() {
    super("cart lease was lost");
  }
}

export class AbandonedCartRecovery {
  private readonly inactivityMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly maxBatchSize: number;
  private readonly operationTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: AbandonedCartRecoveryStore,
    private readonly sender: RecoverySender,
    private readonly options: AbandonedCartRecoveryOptions = {}
  ) {
    this.inactivityMs = integer(options.inactivityMs ?? 60 * 60_000, "inactivityMs", 60_000, 30 * 24 * 60 * 60_000);
    this.leaseMs = integer(options.leaseMs ?? 5 * 60_000, "leaseMs", 1_000, 60 * 60_000);
    this.maxAttempts = integer(options.maxAttempts ?? 5, "maxAttempts", 1, 100);
    this.maxBatchSize = integer(options.maxBatchSize ?? 50, "maxBatchSize", 1, 1_000);
    this.operationTimeoutMs = integer(
      options.operationTimeoutMs ?? 30_000,
      "operationTimeoutMs",
      1,
      5 * 60_000
    );
    if (this.operationTimeoutMs * 2 >= this.leaseMs) {
      throw new Error("operationTimeoutMs must be less than half of leaseMs");
    }
    this.now = options.now ?? Date.now;
    this.currentDate();
  }

  async processBatch(tenantId: string, requestedSize = this.maxBatchSize): Promise<RecoveryBatchResult> {
    const tenant = identifier(tenantId, "tenantId");
    const limit = Math.min(integer(requestedSize, "requestedSize", 1, this.maxBatchSize), this.maxBatchSize);
    const now = this.currentDate();
    const cutoff = new Date(now.getTime() - this.inactivityMs);
    validDate(cutoff, "eligibility cutoff");
    const listed = await this.deadline((signal) => this.store.listEligible(tenant, cutoff, limit, signal));
    if (!Array.isArray(listed) || listed.length > limit) throw new Error("store returned an invalid eligible batch");

    const seen = new Set<string>();
    const result: RecoveryBatchResult = {
      listed: listed.length, claimed: 0, sent: 0, suppressed: 0, failed: 0, busy: 0,
    };
    for (const candidate of listed) {
      const cartId = identifier(candidate?.cartId, "candidate cartId");
      const sequence = integer(candidate?.sequence, "candidate sequence", 1, 10);
      const candidateKey = JSON.stringify([cartId, sequence]);
      if (seen.has(candidateKey)) throw new Error("store returned duplicate eligible carts");
      seen.add(candidateKey);
      const cart = await this.deadline((signal) => this.store.claim({
        tenantId: tenant,
        cartId,
        sequence,
        now: this.currentDate(),
        leaseMs: this.leaseMs,
        maxAttempts: this.maxAttempts,
        signal,
      }));
      if (!cart) {
        result.busy++;
        continue;
      }
      result.claimed++;
      const identity = lease(cart);
      let message: RecoveryMessage;
      try {
        message = snapshot(cart, tenant, cartId, sequence, cutoff, this.maxAttempts);
      } catch (error) {
        await this.recordFailure(identity, cart.attempts, error);
        result.failed++;
        continue;
      }
      const requestHash = hashMessage(message);
      const sendKey = deliveryKey(message, requestHash);

      let dispatch:
        | {
            status: "authorized";
            outcome: "created" | "replay";
            requestHash: string;
            deliveryKey: string;
            message: RecoveryMessage;
          }
        | { status: "conflict"; requestHash: string }
        | { status: "suppressed"; reason: string };
      try {
        await this.heartbeat(identity);
        dispatch = await this.deadline((signal) => this.store.authorizeDispatch({
          lease: identity,
          requestHash,
          deliveryKey: sendKey,
          message,
          now: this.currentDate(),
          signal,
        }));
        if (!dispatch || !["authorized", "conflict", "suppressed"].includes(dispatch.status)) {
          throw new Error("store returned an invalid dispatch decision");
        }
      } catch (error) {
        if (error instanceof LostLeaseError) throw error;
        await this.recordFailure(identity, cart.attempts, error);
        result.failed++;
        continue;
      }
      if (dispatch.status === "suppressed") {
        const reason =
          typeof dispatch.reason === "string" && dispatch.reason.trim()
            ? dispatch.reason.trim().slice(0, MAX_ERROR)
            : "suppressed";
        const transitioned = await this.deadline((signal) =>
          this.store.markSuppressed(identity, reason, this.currentDate(), signal)
        );
        if (!transitioned) throw new LostLeaseError();
        result.suppressed++;
        continue;
      }
      if (dispatch.status === "conflict") {
        await this.recordFailure(identity, cart.attempts, new Error("outbox request hash conflict"));
        result.failed++;
        continue;
      }
      if (
        !["created", "replay"].includes(dispatch.outcome) ||
        dispatch.requestHash !== requestHash ||
        dispatch.deliveryKey !== sendKey ||
        hashMessage(dispatch.message) !== requestHash
      ) {
        await this.recordFailure(identity, cart.attempts, new Error("outbox message did not match request hash"));
        result.failed++;
        continue;
      }

      try {
        await this.heartbeat(identity);
        await this.deadline((signal) =>
          this.sender.sendIdempotently({
            deliveryKey: sendKey,
            requestHash,
            message,
            signal,
          })
        );
      } catch (error) {
        if (error instanceof LostLeaseError) throw error;
        await this.recordFailure(identity, cart.attempts, error);
        result.failed++;
        continue;
      }
      // Transition errors propagate; provider delivery may already have succeeded.
      await this.heartbeat(identity);
      const sent = await this.deadline((signal) =>
        this.store.markSent(identity, this.currentDate(), signal)
      );
      if (!sent) throw new LostLeaseError();
      result.sent++;
    }
    return result;
  }

  private async heartbeat(identity: RecoveryLease): Promise<void> {
    const committedExpiry = await this.deadline((signal) =>
      this.store.renew(identity, this.currentDate(), this.leaseMs, signal)
    );
    if (!committedExpiry) throw new LostLeaseError();
    const remainingMs = validDate(committedExpiry, "committed lease expiry").getTime() - this.currentDate().getTime();
    if (remainingMs <= this.operationTimeoutMs) {
      throw new Error("renewed lease has insufficient operation headroom");
    }
  }

  private async recordFailure(
    identity: RecoveryLease,
    attempts: number,
    original: unknown
  ): Promise<void> {
    const exhausted = attempts >= this.maxAttempts;
    let delay = 60_000;
    if (!exhausted) {
      try {
        const candidate = this.options.retryDelayMs?.(attempts);
        if (candidate !== undefined && Number.isSafeInteger(candidate) && candidate >= 0) {
          delay = Math.min(candidate, MAX_RETRY_MS);
        }
      } catch {
        // A broken retry policy falls back to the bounded default.
      }
    }
    const now = this.currentDate();
    const retryMs = now.getTime() + delay;
    const retryAt = !exhausted && Number.isSafeInteger(retryMs) && Number.isFinite(new Date(retryMs).getTime())
      ? new Date(retryMs)
      : null;
    const message = (original instanceof Error ? original.message : String(original)).slice(0, MAX_ERROR);
    try {
      const failed = await this.deadline((signal) =>
        this.store.markFailed(identity, message || "recovery failed", retryAt, signal)
      );
      if (!failed) throw new LostLeaseError();
    } catch (transitionError) {
      throw new AggregateError([original, transitionError], "recovery operation and failure transition both failed");
    }
  }

  private async deadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("recovery operation timed out"));
      }, this.operationTimeoutMs);
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private currentDate(): Date {
    return validDate(new Date(this.now()), "clock");
  }
}
