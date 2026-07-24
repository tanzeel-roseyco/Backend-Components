import { createHash } from "node:crypto";

export interface ModelRate {
  readonly inputNanoUsdPerToken: bigint;
  readonly outputNanoUsdPerToken: bigint;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ReservationResult =
  | {
      readonly status: "reserved" | "resume";
      readonly requestHash: string;
      readonly estimatedNanoUsd: bigint;
    }
  | { readonly status: "completed"; readonly requestHash: string; readonly result: unknown }
  | { readonly status: "conflict" | "budget_exceeded" };

export interface CostReservationStore {
  /** Begin atomically scopes uniqueness to tenant, actor, endpoint, operation, and request hash. */
  begin(input: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly endpoint: string;
    readonly operationId: string;
    readonly requestHash: string;
    readonly maxRunNanoUsd: bigint;
    readonly estimatedNanoUsd: bigint;
  }): Promise<ReservationResult>;
  /** Success stores the replayable result and charge in the same atomic transition. */
  complete(input: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly endpoint: string;
    readonly operationId: string;
    readonly requestHash: string;
    readonly actualNanoUsd: bigint;
    readonly result: unknown;
  }): Promise<void>;
  /** Unknown usage retains the reservation for provider-billing reconciliation. */
  quarantine(input: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly endpoint: string;
    readonly operationId: string;
    readonly requestHash: string;
    readonly reason: "provider_failure" | "invalid_usage" | "cost_overage";
    readonly actualNanoUsd?: bigint;
  }): Promise<void>;
}

function tokenCount(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000_000) {
    throw new Error(`${label} must be a non-negative safe integer no greater than 10000000000`);
  }
  return BigInt(value);
}

function rate(value: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 1_000_000_000_000n) {
    throw new Error(`${label} must be a bigint in range`);
  }
  return value;
}

export function calculateModelCostNanoUsd(modelRate: ModelRate, usage: Usage): bigint {
  return (
    tokenCount(usage.inputTokens, "inputTokens") * rate(modelRate.inputNanoUsdPerToken, "inputNanoUsdPerToken") +
    tokenCount(usage.outputTokens, "outputTokens") * rate(modelRate.outputNanoUsdPerToken, "outputNanoUsdPerToken")
  );
}

export interface GuardedAiCall<T> {
  readonly tenantId: string;
  readonly actorId: string;
  readonly endpoint: string;
  readonly operationId: string;
  /** SHA-256 of the canonical model, prompt, parameters, and other semantic request inputs. */
  readonly semanticRequestDigest: string;
  readonly maxRunNanoUsd: bigint;
  readonly maximumUsage: Usage;
  readonly rate: ModelRate;
  /** The adapter must return the same provider result for a repeated providerIdempotencyKey. */
  readonly executeIdempotently: (
    providerIdempotencyKey: string,
  ) => Promise<{ readonly value: T; readonly usage: Usage }>;
  readonly decodeReplay: (stored: unknown) => T;
}

function identifier(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const canonical = value.trim();
  if (!canonical || canonical.length > 200 || /[\u0000-\u001F\u007F]/.test(canonical)) {
    throw new Error(`${label} must contain 1-200 printable characters`);
  }
  return canonical;
}

function requestHash(input: {
  readonly maximumUsage: Usage;
  readonly rate: ModelRate;
  readonly maxRunNanoUsd: bigint;
  readonly semanticRequestDigest: string;
}): string {
  const canonical = JSON.stringify({
    maximumInputTokens: input.maximumUsage.inputTokens,
    maximumOutputTokens: input.maximumUsage.outputTokens,
    inputRate: input.rate.inputNanoUsdPerToken.toString(),
    outputRate: input.rate.outputNanoUsdPerToken.toString(),
    maxRunNanoUsd: input.maxRunNanoUsd.toString(),
    semanticRequestDigest: input.semanticRequestDigest,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Reserves fixed-point spend and safely replays calls through a provider idempotency key. */
export async function executeWithCostGuard<T>(
  store: CostReservationStore,
  input: GuardedAiCall<T>,
): Promise<T> {
  const scope = {
    tenantId: identifier(input.tenantId, "tenantId"),
    actorId: identifier(input.actorId, "actorId"),
    endpoint: identifier(input.endpoint, "endpoint"),
    operationId: identifier(input.operationId, "operationId"),
  };
  if (!/^[a-f0-9]{64}$/.test(input.semanticRequestDigest)) {
    throw new Error("semanticRequestDigest must be a lowercase SHA-256 digest");
  }
  if (typeof input.maxRunNanoUsd !== "bigint" || input.maxRunNanoUsd < 0n || input.maxRunNanoUsd > 1_000_000_000_000_000n) {
    throw new Error("maxRunNanoUsd is out of range");
  }
  const estimatedNanoUsd = calculateModelCostNanoUsd(input.rate, input.maximumUsage);
  if (estimatedNanoUsd > input.maxRunNanoUsd) throw new Error("estimated AI cost exceeds the run maximum");
  const hash = requestHash(input);
  const reservation = await store.begin({
    ...scope,
    requestHash: hash,
    maxRunNanoUsd: input.maxRunNanoUsd,
    estimatedNanoUsd,
  });
  if (!reservation || typeof reservation !== "object" || typeof reservation.status !== "string") {
    throw new Error("cost store returned an invalid reservation");
  }
  if (reservation.status === "budget_exceeded") throw new Error("AI cost budget exceeded");
  if (reservation.status === "conflict") throw new Error("AI operation key conflicts with another request");
  if (reservation.status === "completed") {
    if (reservation.requestHash !== hash) throw new Error("stored AI result has a conflicting request hash");
    return input.decodeReplay(reservation.result);
  }
  if (reservation.status !== "reserved" && reservation.status !== "resume") {
    throw new Error("cost store returned an invalid reservation status");
  }
  if (reservation.requestHash !== hash || reservation.estimatedNanoUsd !== estimatedNanoUsd) {
    throw new Error("cost store returned a conflicting reservation");
  }

  const providerKey = createHash("sha256")
    .update(JSON.stringify(["v1", scope.tenantId, scope.actorId, scope.endpoint, scope.operationId, input.semanticRequestDigest]))
    .digest("hex");
  let providerResult: { readonly value: T; readonly usage: Usage };
  try {
    providerResult = await input.executeIdempotently(providerKey);
  } catch (error: unknown) {
    try {
      await store.quarantine({ ...scope, requestHash: hash, reason: "provider_failure" });
    } catch (quarantineError: unknown) {
      throw new AggregateError([error, quarantineError], "AI provider call and quarantine both failed");
    }
    throw error;
  }

  let actualNanoUsd: bigint;
  try {
    actualNanoUsd = calculateModelCostNanoUsd(input.rate, providerResult.usage);
  } catch (error: unknown) {
    try {
      await store.quarantine({ ...scope, requestHash: hash, reason: "invalid_usage" });
    } catch (quarantineError: unknown) {
      throw new AggregateError([error, quarantineError], "AI usage validation and quarantine both failed");
    }
    throw error;
  }
  if (providerResult.usage.inputTokens > input.maximumUsage.inputTokens ||
      providerResult.usage.outputTokens > input.maximumUsage.outputTokens ||
      actualNanoUsd > input.maxRunNanoUsd ||
      actualNanoUsd > estimatedNanoUsd) {
    const overage = new Error("actual AI cost or usage exceeded the reserved maximum");
    try {
      await store.quarantine({
        ...scope,
        requestHash: hash,
        reason: "cost_overage",
        actualNanoUsd,
      });
    } catch (quarantineError: unknown) {
      throw new AggregateError([overage, quarantineError], "AI cost overage and quarantine both failed");
    }
    throw overage;
  }
  await store.complete({
    ...scope,
    requestHash: hash,
    actualNanoUsd,
    result: providerResult.value,
  });
  return providerResult.value;
}
