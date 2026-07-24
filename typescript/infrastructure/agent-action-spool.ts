import { createHash } from "node:crypto";

/**
 * Durable agent-action orchestration without a storage or execution implementation.
 *
 * The store owns atomic idempotency and leases; the injected executor must honor
 * the stable idempotency key so a crash after its side effect remains replay-safe.
 */

export interface AgentActionInput {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly verb: string;
  readonly target: string;
  readonly payload: unknown;
}

export interface ResolvedWorkspace {
  readonly tenantId: string;
  readonly id: string;
  readonly executionScope: string;
}

export interface DurableAgentActionInput extends AgentActionInput {
  /** Canonical digest the store must compare on an idempotency-key replay. */
  readonly fingerprint: string;
}

export interface ClaimedAgentAction extends DurableAgentActionInput {
  readonly id: string;
  readonly leaseToken: string;
  readonly attempts: number;
}

export interface ActionPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface AgentActionSpoolStore {
  /**
   * Atomically deduplicates by tenant/workspace/key and rejects reuse when
   * the existing fingerprint differs. Comparison and insertion are one operation.
   */
  enqueue(input: DurableAgentActionInput): Promise<{ readonly id: string; readonly created: boolean }>;
  /** Atomically leases only due, unfinished actions and increments attempts. */
  claim(input: {
    readonly workerId: string;
    readonly now: Date;
    readonly limit: number;
    readonly leaseMs: number;
    readonly maxAttempts: number;
  }): Promise<readonly ClaimedAgentAction[]>;
  complete(id: string, leaseToken: string, completedAt: Date): Promise<boolean>;
  deny(id: string, leaseToken: string, reason: string, deniedAt: Date): Promise<boolean>;
  fail(
    id: string,
    leaseToken: string,
    error: string,
    nextAttemptAt: Date | null
  ): Promise<boolean>;
}

export interface AgentActionSpoolDependencies {
  readonly store: AgentActionSpoolStore;
  /** Resolves curated IDs only; callers never supply a raw filesystem path. */
  readonly workspaceResolver: {
    resolve(tenantId: string, workspaceId: string): Promise<ResolvedWorkspace | null>;
  };
  readonly policy: {
    authorize(
      action: Readonly<AgentActionInput>,
      workspace: ResolvedWorkspace
    ): Promise<ActionPolicyDecision>;
  };
  /** Must deduplicate repeated calls with the same tenant/workspace/idempotency key. */
  readonly executor: {
    execute(action: Readonly<AgentActionInput>, workspace: ResolvedWorkspace): Promise<void>;
  };
  readonly retryDelayMs?: (attempts: number) => number;
}

export interface AgentActionSpoolOptions {
  readonly maxBatchSize?: number;
  readonly maxAttempts?: number;
  readonly leaseMs?: number;
}

export interface ProcessAgentActionsResult {
  readonly claimed: number;
  readonly executed: number;
  readonly completed: number;
  readonly denied: number;
  readonly failed: number;
  readonly transitionLost: number;
}

const MAX_KEY_CHARS = 128;
const MAX_TEXT_CHARS = 256;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 500;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function bounded(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.length > maximum) throw new RangeError(`${name} cannot exceed ${maximum} characters`);
  return value;
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return value;
}

function snapshotJson(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("payload numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new TypeError("payload must contain only JSON values");
  if (ancestors.has(value)) throw new TypeError("payload must not contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("payload arrays must not contain sparse holes");
        }
        output.push(snapshotJson(value[index], ancestors));
      }
      return Object.freeze(output);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("payload objects must be plain objects");
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      output[key] = snapshotJson((value as Record<string, unknown>)[key], ancestors);
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
}

function validateInput(input: AgentActionInput): AgentActionInput {
  bounded(input?.tenantId, "tenantId", MAX_KEY_CHARS);
  bounded(input?.workspaceId, "workspaceId", MAX_KEY_CHARS);
  bounded(input?.idempotencyKey, "idempotencyKey", MAX_KEY_CHARS);
  bounded(input?.verb, "verb", MAX_KEY_CHARS);
  bounded(input?.target, "target", MAX_TEXT_CHARS);
  const payload = snapshotJson(input.payload);
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`payload cannot exceed ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return Object.freeze({
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    idempotencyKey: input.idempotencyKey,
    verb: input.verb,
    target: input.target,
    payload,
  });
}

function fingerprint(input: AgentActionInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.tenantId,
    input.workspaceId,
    input.idempotencyKey,
    input.verb,
    input.target,
    input.payload,
  ])).digest("hex");
}

function durableFingerprint(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("action fingerprint must be a SHA-256 digest");
  }
  return value;
}

function validateWorkspace(
  workspace: ResolvedWorkspace | null,
  expectedTenantId: string,
  expectedId: string
): ResolvedWorkspace | null {
  if (!workspace) return null;
  bounded(workspace.tenantId, "resolved workspace tenantId", MAX_KEY_CHARS);
  bounded(workspace.id, "resolved workspace id", MAX_KEY_CHARS);
  bounded(workspace.executionScope, "workspace executionScope", MAX_TEXT_CHARS);
  return workspace.tenantId === expectedTenantId && workspace.id === expectedId
    ? Object.freeze({
        tenantId: workspace.tenantId,
        id: workspace.id,
        executionScope: workspace.executionScope,
      })
    : null;
}

function policyReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_ERROR_CHARS) {
    return "denied by action policy";
  }
  return reason;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_ERROR_CHARS) || "action execution failed";
}

export class AgentActionSpool {
  private readonly maxBatchSize: number;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;

  public constructor(
    private readonly dependencies: AgentActionSpoolDependencies,
    options: AgentActionSpoolOptions = {}
  ) {
    this.maxBatchSize = positiveInteger(options.maxBatchSize ?? 50, "maxBatchSize");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 5, "maxAttempts");
    this.leaseMs = positiveInteger(options.leaseMs ?? 60_000, "leaseMs");
  }

  public async enqueue(input: AgentActionInput): Promise<{ id: string; created: boolean }> {
    const validated = validateInput(input);
    const workspace = validateWorkspace(
      await this.dependencies.workspaceResolver.resolve(input.tenantId, input.workspaceId),
      input.tenantId,
      input.workspaceId
    );
    if (!workspace) {
      throw new Error("workspace is not approved for this tenant");
    }
    const result = await this.dependencies.store.enqueue({
      ...validated,
      fingerprint: fingerprint(validated),
    });
    if (typeof result.created !== "boolean") throw new Error("store returned an invalid enqueue result");
    return {
      id: bounded(result.id, "action id", MAX_KEY_CHARS),
      created: result.created,
    };
  }

  public async processBatch(
    workerId: string,
    requestedSize = this.maxBatchSize,
    now = new Date()
  ): Promise<ProcessAgentActionsResult> {
    bounded(workerId, "workerId", MAX_KEY_CHARS);
    validDate(now, "now");
    const limit = Math.min(positiveInteger(requestedSize, "requestedSize"), this.maxBatchSize);
    const claimed = await this.dependencies.store.claim({
      workerId,
      now,
      limit,
      leaseMs: this.leaseMs,
      maxAttempts: this.maxAttempts,
    });
    if (!Array.isArray(claimed) || claimed.length > limit) {
      throw new Error("store returned an invalid claimed-action batch");
    }

    const result = {
      claimed: claimed.length,
      executed: 0,
      completed: 0,
      denied: 0,
      failed: 0,
      transitionLost: 0,
    };
    const claimedIds = new Set<string>();
    for (const action of claimed) {
      const executionInput = validateInput(action);
      if (durableFingerprint(action.fingerprint) !== fingerprint(executionInput)) {
        throw new Error("claimed action fingerprint does not match its durable action");
      }
      bounded(action.id, "action id", MAX_KEY_CHARS);
      if (claimedIds.has(action.id)) throw new Error("store claimed the same action more than once");
      claimedIds.add(action.id);
      bounded(action.leaseToken, "leaseToken", MAX_KEY_CHARS);
      positiveInteger(action.attempts, "attempts");
      if (action.attempts > this.maxAttempts) throw new Error("claimed action exceeded maxAttempts");

      let workspace: ResolvedWorkspace | null;
      try {
        workspace = validateWorkspace(
          await this.dependencies.workspaceResolver.resolve(
            action.tenantId,
            action.workspaceId
          ),
          action.tenantId,
          action.workspaceId
        );
      } catch (error) {
        if (!(await this.recordFailure(action, error, now))) result.transitionLost++;
        result.failed++;
        continue;
      }
      if (!workspace) {
        if (!(await this.transitionSucceeded(this.dependencies.store.deny(
            action.id,
            action.leaseToken,
            "workspace is no longer approved for this tenant",
            now
          )))) result.transitionLost++;
        result.denied++;
        continue;
      }

      let decision: ActionPolicyDecision;
      try {
        decision = await this.dependencies.policy.authorize(executionInput, workspace);
      } catch (error) {
        if (!(await this.recordFailure(action, error, now))) result.transitionLost++;
        result.failed++;
        continue;
      }
      if (!decision || typeof decision.allowed !== "boolean") {
        if (!(await this.recordFailure(action, "policy returned an invalid decision", now))) {
          result.transitionLost++;
        }
        result.failed++;
        continue;
      }
      if (!decision.allowed) {
        const reason = policyReason(decision.reason);
        if (!(await this.transitionSucceeded(
          this.dependencies.store.deny(action.id, action.leaseToken, reason, now)
        ))) {
          result.transitionLost++;
        }
        result.denied++;
        continue;
      }

      try {
        await this.dependencies.executor.execute(executionInput, workspace);
      } catch (error) {
        if (!(await this.recordFailure(action, error, now))) result.transitionLost++;
        result.failed++;
        continue;
      }
      result.executed++;
      // A lost completion lease is not an execution failure: retrying it here
      // would misclassify a side effect that may already have succeeded.
      if (await this.transitionSucceeded(
        this.dependencies.store.complete(action.id, action.leaseToken, now)
      )) {
        result.completed++;
      } else {
        result.transitionLost++;
      }
    }
    return result;
  }

  private async recordFailure(
    action: ClaimedAgentAction,
    error: unknown,
    now: Date
  ): Promise<boolean> {
    const exhausted = action.attempts >= this.maxAttempts;
    let delay = DEFAULT_RETRY_DELAY_MS;
    if (!exhausted && this.dependencies.retryDelayMs) {
      try {
        const candidate = this.dependencies.retryDelayMs(action.attempts);
        if (Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= MAX_RETRY_DELAY_MS) {
          delay = candidate;
        }
      } catch {
        // Retry configuration cannot strand a claimed action; use the safe default.
      }
    }
    const retryAtMs = now.getTime() + delay;
    const retryAt = new Date(retryAtMs);
    const nextAttemptAt =
      exhausted || !Number.isSafeInteger(retryAtMs) || !Number.isFinite(retryAt.getTime())
        ? null
        : retryAt;
    return this.transitionSucceeded(
      this.dependencies.store.fail(
        action.id,
        action.leaseToken,
        errorText(error),
        nextAttemptAt
      )
    );
  }

  private async transitionSucceeded(transition: Promise<boolean>): Promise<boolean> {
    try {
      return await transition;
    } catch {
      return false;
    }
  }
}
