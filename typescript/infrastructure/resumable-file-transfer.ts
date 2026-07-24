import { createHash } from "node:crypto";

export interface TransferRecord {
  id: string;
  tenantId: string;
  sourceKey: string;
  copyKey: string;
  sizeBytes: number;
  checksumSha256: string;
  status: "copying";
  attempts: number;
  offset: number;
  leaseToken: string;
  fence: number;
  sessionId?: string;
  destinationId?: string;
}

export interface LeaseIdentity {
  tenantId: string;
  transferId: string;
  leaseToken: string;
  fence: number;
}

export interface TransferStore {
  claim(input: {
    tenantId: string;
    transferId: string;
    now: Date;
    leaseMs: number;
    maxAttempts: number;
    signal: AbortSignal;
  }): Promise<TransferRecord | null>;
  renew(lease: LeaseIdentity, now: Date, leaseMs: number, signal: AbortSignal): Promise<boolean>;
  findCompletedByCopyKey(
    tenantId: string,
    copyKey: string,
    signal: AbortSignal
  ): Promise<TransferRecord | null>;
  saveProgress(
    lease: LeaseIdentity,
    expectedOffset: number,
    nextOffset: number,
    sessionId: string,
    signal: AbortSignal
  ): Promise<boolean>;
  markComplete(
    lease: LeaseIdentity,
    destinationId: string,
    sizeBytes: number,
    checksumSha256: string,
    signal: AbortSignal
  ): Promise<boolean>;
  markError(lease: LeaseIdentity, error: string, signal: AbortSignal): Promise<boolean>;
  listStranded(
    tenantId: string,
    now: Date,
    limit: number,
    maxAttempts: number,
    signal: AbortSignal
  ): Promise<readonly string[]>;
}

export interface SourceObjectStore {
  readChunk(
    tenantId: string,
    sourceKey: string,
    offset: number,
    length: number,
    signal: AbortSignal
  ): Promise<Uint8Array>;
}

export interface CompletedDestination {
  destinationId: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface DestinationObjectStore {
  beginOrResume(input: {
    tenantId: string;
    copyKey: string;
    sessionId?: string;
    sizeBytes: number;
    checksumSha256: string;
    fence: number;
    signal: AbortSignal;
  }): Promise<{ sessionId: string; offset: number; completed?: CompletedDestination }>;
  append(
    tenantId: string,
    sessionId: string,
    fence: number,
    exactOffset: number,
    bytes: Uint8Array,
    signal: AbortSignal
  ): Promise<number>;
  complete(
    tenantId: string,
    sessionId: string,
    fence: number,
    signal: AbortSignal
  ): Promise<CompletedDestination>;
}

export interface ResumableFileTransferOptions {
  chunkSize?: number;
  maxFileBytes?: number;
  leaseMs?: number;
  maxAttempts?: number;
  maxReconcileBatch?: number;
  operationTimeoutMs?: number;
  totalTimeoutMs?: number;
  now?: () => number;
}

export type TransferResult =
  | { status: "complete"; destinationId: string; duplicate: boolean }
  | { status: "busy" };

const MIB = 1024 * 1024;
const MAX_ERROR_LENGTH = 500;
const MAX_KEY_LENGTH = 500;

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function text(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  if (value.length > MAX_KEY_LENGTH) throw new RangeError(`${name} is too long`);
  return value;
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`${name} is invalid`);
  return value;
}

function lease(record: TransferRecord): LeaseIdentity {
  return {
    tenantId: record.tenantId,
    transferId: record.id,
    leaseToken: record.leaseToken,
    fence: record.fence,
  };
}

class LostLeaseError extends Error {
  constructor() {
    super("transfer lease was lost");
  }
}

export class ResumableFileTransfer {
  private readonly chunkSize: number;
  private readonly maxFileBytes: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly maxReconcileBatch: number;
  private readonly operationTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: TransferStore,
    private readonly source: SourceObjectStore,
    private readonly destination: DestinationObjectStore,
    options: ResumableFileTransferOptions = {}
  ) {
    this.chunkSize = integer(options.chunkSize ?? 5 * MIB, "chunkSize", 1, 16 * MIB);
    this.maxFileBytes = integer(
      options.maxFileBytes ?? 5 * 1024 * MIB,
      "maxFileBytes",
      1,
      100 * 1024 * MIB
    );
    this.leaseMs = integer(options.leaseMs ?? 20 * 60_000, "leaseMs", 1_000, 24 * 60 * 60_000);
    this.maxAttempts = integer(options.maxAttempts ?? 5, "maxAttempts", 1, 100);
    this.maxReconcileBatch = integer(options.maxReconcileBatch ?? 25, "maxReconcileBatch", 1, 1_000);
    this.operationTimeoutMs = integer(
      options.operationTimeoutMs ?? 30_000,
      "operationTimeoutMs",
      1,
      5 * 60_000
    );
    this.totalTimeoutMs = integer(
      options.totalTimeoutMs ?? 15 * 60_000,
      "totalTimeoutMs",
      this.operationTimeoutMs,
      24 * 60 * 60_000
    );
    if (this.operationTimeoutMs >= this.leaseMs) {
      throw new RangeError("operationTimeoutMs must be shorter than leaseMs");
    }
    this.now = options.now ?? Date.now;
    this.currentDate();
  }

  async process(tenantId: string, transferId: string): Promise<TransferResult> {
    const tenant = text(tenantId, "tenantId");
    const id = text(transferId, "transferId");
    const startedAt = this.currentDate().getTime();
    const record = await this.deadline((signal) =>
      this.store.claim({
        tenantId: tenant,
        transferId: id,
        now: this.currentDate(),
        leaseMs: this.leaseMs,
        maxAttempts: this.maxAttempts,
        signal,
      })
    );
    if (!record) return { status: "busy" };

    let ownsLease = true;
    try {
      this.validateRecord(record, tenant, id);
      const identity = lease(record);
      const duplicate = await this.deadline((signal) =>
        this.store.findCompletedByCopyKey(tenant, record.copyKey, signal)
      );
      if (duplicate?.destinationId) {
        if (duplicate.tenantId !== tenant || duplicate.copyKey !== record.copyKey) {
          throw new Error("store returned a completed copy from the wrong tenant or scope");
        }
        this.validateCompleted(
          {
            destinationId: duplicate.destinationId,
            sizeBytes: duplicate.sizeBytes,
            checksumSha256: duplicate.checksumSha256,
          },
          record
        );
        await this.completeState(identity, duplicate.destinationId, record, startedAt);
        return { status: "complete", destinationId: duplicate.destinationId, duplicate: true };
      }

      await this.heartbeat(identity, startedAt);
      const session = await this.deadline((signal) =>
        this.destination.beginOrResume({
          tenantId: tenant,
          copyKey: record.copyKey,
          sessionId: record.sessionId,
          sizeBytes: record.sizeBytes,
          checksumSha256: record.checksumSha256,
          fence: record.fence,
          signal,
        })
      );
      text(session?.sessionId, "sessionId");
      if (!Number.isSafeInteger(session.offset) || session.offset < record.offset || session.offset > record.sizeBytes) {
        throw new Error("destination returned an invalid resume offset");
      }
      if (session.completed) {
        this.validateCompleted(session.completed, record);
        await this.completeState(identity, session.completed.destinationId, record, startedAt);
        return { status: "complete", destinationId: session.completed.destinationId, duplicate: true };
      }

      let persistedOffset = record.offset;
      if (session.offset !== record.offset || !record.sessionId) {
        await this.save(identity, record.offset, session.offset, session.sessionId);
        persistedOffset = session.offset;
      }

      const hash = createHash("sha256");
      let readOffset = 0;
      while (readOffset < record.sizeBytes) {
        await this.heartbeat(identity, startedAt);
        const length = Math.min(this.chunkSize, record.sizeBytes - readOffset);
        const bytes = await this.deadline((signal) =>
          this.source.readChunk(tenant, record.sourceKey, readOffset, length, signal)
        );
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
          throw new Error(`source returned ${bytes?.byteLength ?? "invalid"} bytes; expected ${length}`);
        }
        hash.update(bytes);

        const uploadStart = Math.max(persistedOffset, readOffset);
        const readEnd = readOffset + length;
        if (uploadStart < readEnd) {
          const uploadBytes = bytes.subarray(uploadStart - readOffset);
          await this.heartbeat(identity, startedAt);
          const nextOffset = await this.deadline((signal) =>
            this.destination.append(
              tenant,
              session.sessionId,
              record.fence,
              uploadStart,
              uploadBytes,
              signal
            )
          );
          if (nextOffset !== readEnd) throw new Error("destination returned an invalid next offset");
          await this.save(identity, persistedOffset, nextOffset, session.sessionId);
          persistedOffset = nextOffset;
        }
        readOffset = readEnd;
      }

      if (hash.digest("hex") !== record.checksumSha256) throw new Error("source checksum mismatch");
      await this.heartbeat(identity, startedAt);
      const completed = await this.deadline((signal) =>
        this.destination.complete(tenant, session.sessionId, record.fence, signal)
      );
      this.validateCompleted(completed, record);
      await this.completeState(identity, completed.destinationId, record, startedAt);
      return { status: "complete", destinationId: completed.destinationId, duplicate: false };
    } catch (error) {
      if (error instanceof LostLeaseError) ownsLease = false;
      if (ownsLease) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
        const transitioned = await this.deadline((signal) => this.store.markError(lease(record), message, signal));
        if (!transitioned) ownsLease = false;
      }
      throw error;
    }
  }

  async reconcile(tenantId: string, requestedLimit = this.maxReconcileBatch): Promise<{
    attempted: number;
    completed: number;
    busy: number;
    failed: number;
  }> {
    const tenant = text(tenantId, "tenantId");
    const limit = Math.min(
      integer(requestedLimit, "requestedLimit", 1, this.maxReconcileBatch),
      this.maxReconcileBatch
    );
    const ids = await this.deadline((signal) =>
      this.store.listStranded(tenant, this.currentDate(), limit, this.maxAttempts, signal)
    );
    if (!Array.isArray(ids) || ids.length > limit) throw new Error("store returned an invalid reconciliation batch");
    const seen = new Set<string>();
    for (const id of ids) {
      text(id, "stranded transfer id");
      if (seen.has(id)) throw new Error("store returned duplicate stranded transfer ids");
      seen.add(id);
    }
    const summary = { attempted: ids.length, completed: 0, busy: 0, failed: 0 };
    for (const id of ids) {
      try {
        const result = await this.process(tenant, id);
        if (result.status === "complete") summary.completed++;
        else summary.busy++;
      } catch {
        summary.failed++;
      }
    }
    return summary;
  }

  private validateRecord(record: TransferRecord, tenantId: string, transferId: string): void {
    if (!record || typeof record !== "object") throw new Error("store returned an invalid transfer");
    if (text(record.tenantId, "record tenantId") !== tenantId) throw new Error("store returned the wrong tenant");
    if (text(record.id, "record id") !== transferId) throw new Error("store returned the wrong transfer");
    text(record.sourceKey, "sourceKey");
    text(record.copyKey, "copyKey");
    if (!/^[a-f0-9]{64}$/.test(record.checksumSha256)) throw new Error("checksumSha256 is invalid");
    integer(record.sizeBytes, "sizeBytes", 1, this.maxFileBytes);
    integer(record.offset, "offset", 0, record.sizeBytes);
    integer(record.attempts, "attempts", 1, this.maxAttempts);
    if (record.status !== "copying") throw new Error("claimed transfer must be copying");
    text(record.leaseToken, "leaseToken");
    integer(record.fence, "fence", 1, Number.MAX_SAFE_INTEGER);
    if (record.sessionId !== undefined) text(record.sessionId, "sessionId");
  }

  private validateCompleted(completed: CompletedDestination, record: TransferRecord): void {
    text(completed?.destinationId, "destinationId");
    if (completed.sizeBytes !== record.sizeBytes) throw new Error("destination size mismatch");
    if (completed.checksumSha256 !== record.checksumSha256) throw new Error("destination checksum mismatch");
  }

  private async heartbeat(identity: LeaseIdentity, startedAt: number): Promise<void> {
    if (this.currentDate().getTime() - startedAt >= this.totalTimeoutMs) {
      throw new Error("transfer exceeded total timeout");
    }
    const renewed = await this.deadline((signal) =>
      this.store.renew(identity, this.currentDate(), this.leaseMs, signal)
    );
    if (!renewed) throw new LostLeaseError();
  }

  private async save(
    identity: LeaseIdentity,
    expectedOffset: number,
    nextOffset: number,
    sessionId: string
  ): Promise<void> {
    const saved = await this.deadline((signal) =>
      this.store.saveProgress(identity, expectedOffset, nextOffset, sessionId, signal)
    );
    if (!saved) throw new LostLeaseError();
  }

  private async completeState(
    identity: LeaseIdentity,
    destinationId: string,
    record: TransferRecord,
    startedAt: number
  ): Promise<void> {
    await this.heartbeat(identity, startedAt);
    const completed = await this.deadline((signal) =>
      this.store.markComplete(
        identity,
        destinationId,
        record.sizeBytes,
        record.checksumSha256,
        signal
      )
    );
    if (!completed) throw new LostLeaseError();
  }

  private async deadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeoutError = new Error("transfer operation timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, this.operationTimeoutMs);
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private currentDate(): Date {
    const date = new Date(this.now());
    return validDate(date, "clock");
  }
}
