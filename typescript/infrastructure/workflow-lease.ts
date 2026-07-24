import { randomUUID } from "node:crypto";

/** A lease must accompany every protected write as a fencing token. */
export interface WorkflowLease {
  readonly key: string;
  readonly owner: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly expiresAt: Date;
}

export interface WorkflowLeaseStore {
  acquire(key: string, owner: string, ttlMs: number): Promise<WorkflowLease | null>;
  renew(lease: WorkflowLease, ttlMs: number): Promise<WorkflowLease | null>;
  release(lease: WorkflowLease): Promise<boolean>;
}

interface StoredLease {
  readonly key: string;
  readonly owner: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly expiresAtMs: number;
}

type Clock = () => Date;
type IdFactory = () => string;

/**
 * Single-process lease store for tests and development only. Distributed stores
 * must acquire and fence using an atomic operation and the database clock.
 */
export class InMemoryWorkflowLeaseStore implements WorkflowLeaseStore {
  private readonly leases = new Map<string, StoredLease>();
  private readonly fencingTokens = new Map<string, number>();

  constructor(
    private readonly clock: Clock = () => new Date(),
    private readonly maxTtlMs = 60 * 60 * 1000,
    private readonly idFactory: IdFactory = randomUUID,
  ) {
    if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1) {
      throw new Error("maxTtlMs must be a positive safe integer");
    }
  }

  async acquire(key: string, owner: string, ttlMs: number): Promise<WorkflowLease | null> {
    this.validateIdentity(key, owner);
    const nowMs = this.nowMs();
    const expiresAtMs = this.expiryMs(nowMs, ttlMs);
    const current = this.leases.get(key);
    if (current && current.expiresAtMs > nowMs) return null;

    const previousToken = this.fencingTokens.get(key) ?? 0;
    if (previousToken >= Number.MAX_SAFE_INTEGER) {
      throw new Error("fencing token space exhausted");
    }
    const fencingToken = previousToken + 1;
    const stored = {
      key,
      owner,
      leaseId: this.createLeaseId(),
      fencingToken,
      expiresAtMs,
    };
    this.leases.set(key, stored);
    this.fencingTokens.set(key, fencingToken);
    return this.snapshot(stored);
  }

  async renew(lease: WorkflowLease, ttlMs: number): Promise<WorkflowLease | null> {
    this.validateLease(lease);
    const nowMs = this.nowMs();
    const current = this.leases.get(lease.key);
    if (!current || !this.matches(current, lease) || current.expiresAtMs <= nowMs) return null;

    const renewed = { ...current, expiresAtMs: this.expiryMs(nowMs, ttlMs) };
    this.leases.set(lease.key, renewed);
    return this.snapshot(renewed);
  }

  async release(lease: WorkflowLease): Promise<boolean> {
    this.validateLease(lease);
    const current = this.leases.get(lease.key);
    if (!current || !this.matches(current, lease)) return false;
    this.leases.delete(lease.key);
    return true;
  }

  private nowMs(): number {
    const nowMs = this.clock().getTime();
    if (!Number.isFinite(nowMs)) throw new Error("clock returned an invalid date");
    return nowMs;
  }

  private expiryMs(nowMs: number, ttlMs: number): number {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > this.maxTtlMs) {
      throw new Error(`ttlMs must be between 1 and ${this.maxTtlMs}`);
    }
    const expiresAtMs = nowMs + ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw new Error("ttlMs produces an invalid expiry");
    if (!Number.isFinite(new Date(expiresAtMs).getTime())) {
      throw new Error("ttlMs produces an invalid expiry");
    }
    return expiresAtMs;
  }

  private createLeaseId(): string {
    const leaseId = this.idFactory();
    if (typeof leaseId !== "string" || !leaseId.trim()) throw new Error("idFactory returned an invalid ID");
    return leaseId;
  }

  private matches(stored: StoredLease, supplied: WorkflowLease): boolean {
    return stored.leaseId === supplied.leaseId
      && stored.owner === supplied.owner
      && stored.fencingToken === supplied.fencingToken;
  }

  private snapshot(stored: StoredLease): WorkflowLease {
    return { ...stored, expiresAt: new Date(stored.expiresAtMs) };
  }

  private validateIdentity(key: string, owner: string): void {
    if (typeof key !== "string" || typeof owner !== "string" || !key.trim() || !owner.trim()) {
      throw new Error("key and owner are required");
    }
  }

  private validateLease(lease: WorkflowLease): void {
    if (!lease || typeof lease !== "object") throw new Error("a valid lease is required");
    this.validateIdentity(lease.key, lease.owner);
    if (!lease.leaseId || !Number.isSafeInteger(lease.fencingToken)) {
      throw new Error("a valid lease is required");
    }
  }
}
