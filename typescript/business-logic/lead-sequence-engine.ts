export interface LeadInput<TPayload> {
  canonicalEmailKey: string;
  idempotencyKey: string;
  payload: TPayload;
  steps: ReadonlyArray<{
    idempotencyKey: string;
    delayMs: number;
    payload: unknown;
  }>;
}

export interface ClaimedLeadStep {
  id: string;
  leadId: string;
  canonicalEmailKey: string;
  idempotencyKey: string;
  payload: unknown;
  attempts: number;
}

export interface LeadSequenceStore<TPayload> {
  /**
   * Atomically deduplicates both keys and enqueues every step. Implementations
   * must return the existing lead when either key has already been accepted.
   */
  intake(input: {
    canonicalEmailKey: string;
    idempotencyKey: string;
    payload: TPayload;
    steps: ReadonlyArray<{
      idempotencyKey: string;
      payload: unknown;
      dueAt: Date;
    }>;
  }): Promise<{ leadId: string; created: boolean }>;
  claimDueSteps(
    now: Date,
    limit: number,
    maxAttempts: number
  ): Promise<ReadonlyArray<ClaimedLeadStep>>;
  markSuppressed(stepId: string, reason: string): Promise<void>;
  markSent(stepId: string, sentAt: Date): Promise<void>;
  markFailed(
    stepId: string,
    error: string,
    nextAttemptAt: Date | null
  ): Promise<void>;
}

export interface LeadSequenceDependencies<TPayload> {
  store: LeadSequenceStore<TPayload>;
  suppression: {
    check(canonicalEmailKey: string): Promise<{ suppressed: boolean; reason?: string }>;
  };
  sender: {
    /** The provider must deduplicate repeated calls with the same deliveryKey. */
    sendIdempotently(input: {
      leadId: string;
      payload: unknown;
      deliveryKey: string;
    }): Promise<void>;
  };
  retryDelayMs?: (attempts: number) => number;
}

export interface LeadSequenceOptions {
  maxBatchSize?: number;
  maxAttempts?: number;
  maxStepsPerLead?: number;
}

export interface ProcessBatchResult {
  claimed: number;
  sent: number;
  suppressed: number;
  failed: number;
}

const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_STEPS_PER_LEAD = 50;
const MAX_BATCH_SIZE = 1_000;
const MAX_ATTEMPTS = 100;
const MAX_STEPS_PER_LEAD = 1_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 86_400_000;
const MAX_EMAIL_KEY_LENGTH = 320;
const MAX_KEY_LENGTH = 200;
const MAX_STORED_MESSAGE_LENGTH = 500;
const MAX_DATE_MS = 8_640_000_000_000_000;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function cappedPositiveInteger(value: number, name: string, maximum: number): number {
  const result = positiveInteger(value, name);
  if (result > maximum) throw new RangeError(`${name} cannot exceed ${maximum}`);
  return result;
}

function requiredKey(value: string, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const key = value.trim();
  if (!key) throw new TypeError(`${name} must not be empty`);
  if (key.length > maxLength) {
    throw new RangeError(`${name} cannot exceed ${maxLength} characters`);
  }
  return key;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_STORED_MESSAGE_LENGTH
  );
}

function claimedStep(value: unknown, maxAttempts: number): ClaimedLeadStep {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("store returned a malformed claimed step");
  }
  const step = value as Partial<ClaimedLeadStep>;
  const attempts = positiveInteger(step.attempts as number, "claimed attempts");
  if (attempts > maxAttempts) {
    throw new RangeError("claimed attempts exceeds maxAttempts");
  }
  return {
    id: requiredKey(step.id as string, "claimed step id", MAX_KEY_LENGTH),
    leadId: requiredKey(step.leadId as string, "claimed leadId", MAX_KEY_LENGTH),
    canonicalEmailKey: requiredKey(
      step.canonicalEmailKey as string,
      "claimed canonicalEmailKey",
      MAX_EMAIL_KEY_LENGTH
    ),
    idempotencyKey: requiredKey(
      step.idempotencyKey as string,
      "claimed idempotencyKey",
      MAX_KEY_LENGTH
    ),
    payload: step.payload,
    attempts,
  };
}

export class LeadSequenceEngine<TPayload> {
  private readonly maxBatchSize: number;
  private readonly maxAttempts: number;
  private readonly maxStepsPerLead: number;

  constructor(
    private readonly dependencies: LeadSequenceDependencies<TPayload>,
    options: LeadSequenceOptions = {}
  ) {
    this.maxBatchSize = cappedPositiveInteger(
      options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      "maxBatchSize",
      MAX_BATCH_SIZE,
    );
    this.maxAttempts = cappedPositiveInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "maxAttempts",
      MAX_ATTEMPTS,
    );
    this.maxStepsPerLead = cappedPositiveInteger(
      options.maxStepsPerLead ?? DEFAULT_MAX_STEPS_PER_LEAD,
      "maxStepsPerLead",
      MAX_STEPS_PER_LEAD,
    );
  }

  async intake(
    input: LeadInput<TPayload>,
    acceptedAt: Date = new Date()
  ): Promise<{ leadId: string; created: boolean }> {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object");
    if (!Array.isArray(input.steps)) throw new TypeError("steps must be an array");
    if (!Number.isFinite(acceptedAt.getTime())) {
      throw new TypeError("acceptedAt must be a valid date");
    }
    if (input.steps.length > this.maxStepsPerLead) {
      throw new RangeError(`steps cannot exceed ${this.maxStepsPerLead}`);
    }

    const canonicalEmailKey = requiredKey(
      input.canonicalEmailKey,
      "canonicalEmailKey",
      MAX_EMAIL_KEY_LENGTH
    );
    const idempotencyKey = requiredKey(
      input.idempotencyKey,
      "idempotencyKey",
      MAX_KEY_LENGTH
    );
    const seenStepKeys = new Set<string>();
    const steps = input.steps.map((step) => {
      const stepKey = requiredKey(
        step.idempotencyKey,
        "step.idempotencyKey",
        MAX_KEY_LENGTH
      );
      if (seenStepKeys.has(stepKey)) {
        throw new TypeError(`duplicate step idempotency key: ${stepKey}`);
      }
      seenStepKeys.add(stepKey);
      if (!Number.isSafeInteger(step.delayMs) || step.delayMs < 0) {
        throw new RangeError("step.delayMs must be a non-negative safe integer");
      }
      const dueAtMs = acceptedAt.getTime() + step.delayMs;
      if (!Number.isSafeInteger(dueAtMs) || dueAtMs > MAX_DATE_MS) {
        throw new RangeError("step dueAt exceeds the supported date range");
      }
      return {
        idempotencyKey: stepKey,
        payload: step.payload,
        dueAt: new Date(dueAtMs),
      };
    });

    const result: unknown = await this.dependencies.store.intake({
      canonicalEmailKey,
      idempotencyKey,
      payload: input.payload,
      steps,
    });
    if (typeof result !== "object" || result === null) {
      throw new TypeError("store returned a malformed intake result");
    }
    const candidate = result as { leadId?: unknown; created?: unknown };
    if (typeof candidate.created !== "boolean") {
      throw new TypeError("store intake result created must be boolean");
    }
    return {
      leadId: requiredKey(candidate.leadId as string, "leadId", MAX_KEY_LENGTH),
      created: candidate.created,
    };
  }

  async processBatch(
    requestedSize: number = this.maxBatchSize,
    now: Date = new Date()
  ): Promise<ProcessBatchResult> {
    if (!Number.isFinite(now.getTime())) throw new TypeError("now must be a valid date");
    const limit = Math.min(positiveInteger(requestedSize, "requestedSize"), this.maxBatchSize);
    const rawClaimed: unknown = await this.dependencies.store.claimDueSteps(
      now,
      limit,
      this.maxAttempts
    );
    if (!Array.isArray(rawClaimed)) {
      throw new TypeError("store claim result must be an array");
    }
    if (rawClaimed.length > limit) {
      throw new Error("store returned more claimed steps than requested");
    }
    const claimed = rawClaimed.map((step) => claimedStep(step, this.maxAttempts));
    const claimedIds = new Set<string>();
    const deliveryKeys = new Set<string>();
    for (const step of claimed) {
      if (claimedIds.has(step.id)) throw new Error("store returned duplicate claimed step ids");
      if (deliveryKeys.has(step.idempotencyKey)) {
        throw new Error("store returned duplicate claimed delivery keys");
      }
      claimedIds.add(step.id);
      deliveryKeys.add(step.idempotencyKey);
    }

    const result: ProcessBatchResult = {
      claimed: claimed.length,
      sent: 0,
      suppressed: 0,
      failed: 0,
    };

    for (const step of claimed) {
      let decision: { suppressed: boolean; reason?: string };
      let suppressionReason = "suppressed";
      try {
        decision = await this.dependencies.suppression.check(
          step.canonicalEmailKey
        );
        if (typeof decision?.suppressed !== "boolean") {
          throw new TypeError("suppression result was malformed");
        }
        if (decision.reason !== undefined && typeof decision.reason !== "string") {
          throw new TypeError("suppression reason was malformed");
        }
        suppressionReason = (decision.reason ?? suppressionReason).slice(
          0,
          MAX_STORED_MESSAGE_LENGTH
        );
      } catch (error) {
        await this.markDeliveryFailed(step, error, now);
        result.failed++;
        continue;
      }

      if (decision.suppressed) {
        await this.dependencies.store.markSuppressed(step.id, suppressionReason);
        result.suppressed++;
        continue;
      }

      try {
        await this.dependencies.sender.sendIdempotently({
          leadId: step.leadId,
          payload: step.payload,
          deliveryKey: step.idempotencyKey,
        });
      } catch (error) {
        await this.markDeliveryFailed(step, error, now);
        result.failed++;
        continue;
      }

      // Transition errors propagate: marking a delivered message as failed
      // would create a false failure. Reclaims safely replay the delivery key.
      await this.dependencies.store.markSent(step.id, now);
      result.sent++;
    }

    return result;
  }

  private async markDeliveryFailed(
    step: ClaimedLeadStep,
    error: unknown,
    now: Date
  ): Promise<void> {
    if (step.attempts >= this.maxAttempts) {
      await this.dependencies.store.markFailed(step.id, errorMessage(error), null);
      return;
    }

    let delay = DEFAULT_RETRY_DELAY_MS;
    try {
      const candidate = this.dependencies.retryDelayMs?.(step.attempts);
      if (candidate !== undefined && Number.isSafeInteger(candidate) && candidate >= 0) {
        delay = Math.min(candidate, MAX_RETRY_DELAY_MS);
      }
    } catch {
      // A broken retry policy falls back to a bounded delay; the send failure
      // still needs a durable transition.
    }
    const retryAtMs = now.getTime() + delay;
    const nextAttemptAt =
      Number.isSafeInteger(retryAtMs) && retryAtMs <= MAX_DATE_MS
        ? new Date(retryAtMs)
        : null;
    await this.dependencies.store.markFailed(
      step.id,
      errorMessage(error),
      nextAttemptAt
    );
  }
}
