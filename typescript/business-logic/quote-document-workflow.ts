import { createHash } from "node:crypto";

export interface QuoteDocument {
  readonly name: string;
  readonly mimeType: "application/pdf" | "image/png" | "image/jpeg";
  readonly content: Uint8Array;
}

export interface ExtractedQuoteLine {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface ValidatedQuote {
  readonly lines: readonly ExtractedQuoteLine[];
  readonly subtotalCents: number;
}

export interface QuoteArtifacts {
  readonly pdf: Uint8Array;
  readonly xlsx: Uint8Array;
}

interface ProviderCall {
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface QuoteExtractor {
  /** Repeated idempotencyKey calls must return the same extraction outcome. */
  readonly extract: (input: ProviderCall & {
    readonly document: QuoteDocument;
    readonly maxLines: number;
  }) => Promise<readonly ExtractedQuoteLine[]>;
}

export interface QuoteRenderer {
  /** Repeated idempotencyKey calls must return byte-identical artifacts. */
  readonly render: (input: ProviderCall & {
    readonly quote: ValidatedQuote;
    readonly maxArtifactBytes: number;
  }) => Promise<QuoteArtifacts>;
}

export interface QuoteDelivery {
  /** Repeated idempotencyKey calls must return the same delivery without sending twice. */
  readonly deliver: (input: ProviderCall & {
    readonly recipient: string;
    readonly artifacts: QuoteArtifacts;
  }) => Promise<{ readonly deliveryId: string }>;
}

export type QuoteJobState = "processing" | "pending_approval" | "approved" | "delivering" | "delivered";

export interface QuoteJobSnapshot {
  readonly tenantId: string;
  readonly jobId: string;
  readonly state: QuoteJobState;
  readonly requestHash: string;
  readonly quote?: ValidatedQuote;
  readonly artifacts?: QuoteArtifacts;
  readonly approvalId?: string;
  readonly deliveryRequestHash?: string;
  readonly deliveryId?: string;
}

export type ClaimResult =
  | { readonly kind: "claimed"; readonly fence: number }
  | { readonly kind: "busy" }
  | { readonly kind: "existing"; readonly snapshot: QuoteJobSnapshot };

interface StoreCall {
  readonly signal: AbortSignal;
}

export interface QuoteWorkflowStore {
  /** Atomically creates or lease-takes a job; requestHash mismatch must reject. */
  readonly claimPreparation: (
    tenantId: string,
    jobId: string,
    requestHash: string,
    leaseMs: number,
    call: StoreCall,
  ) => Promise<ClaimResult>;
  readonly renewLease: (
    tenantId: string,
    jobId: string,
    fence: number,
    leaseMs: number,
    call: StoreCall,
  ) => Promise<boolean>;
  readonly savePrepared: (
    tenantId: string,
    jobId: string,
    fence: number,
    quote: ValidatedQuote,
    artifacts: QuoteArtifacts,
    call: StoreCall,
  ) => Promise<QuoteJobSnapshot>;
  readonly approveOnce: (
    tenantId: string,
    jobId: string,
    approvalId: string,
    call: StoreCall,
  ) => Promise<QuoteJobSnapshot>;
  /** requestHash mismatch must reject before returning an existing delivery. */
  readonly claimDelivery: (
    tenantId: string,
    jobId: string,
    approvalId: string,
    requestHash: string,
    leaseMs: number,
    call: StoreCall,
  ) => Promise<ClaimResult>;
  readonly saveDelivered: (
    tenantId: string,
    jobId: string,
    fence: number,
    requestHash: string,
    deliveryId: string,
    call: StoreCall,
  ) => Promise<QuoteJobSnapshot>;
}

export interface QuoteDocumentWorkflowOptions {
  readonly maxDocumentBytes?: number;
  readonly maxLines?: number;
  readonly maxArtifactBytes?: number;
  readonly operationTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly leaseMs?: number;
}

const ARTIFACT_NAMES = ["pdf", "xlsx"] as const;

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function text(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > maximum) throw new Error(`${name} cannot exceed ${maximum} characters`);
  return value;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function key(namespace: string, parts: readonly string[]): string {
  const framed = parts.map((part) => `${Buffer.byteLength(part)}:${part}`).join("|");
  return `${namespace}:v2:${createHash("sha256").update(framed).digest("hex")}`;
}

function validateQuote(lines: readonly ExtractedQuoteLine[], maximum: number): ValidatedQuote {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > maximum) {
    throw new Error(`extracted lines must contain 1 to ${maximum} items`);
  }
  let subtotalCents = 0;
  const validated = lines.map((line, index) => {
    if (!line || typeof line !== "object") throw new Error(`line ${index} is malformed`);
    const description = text(line.description, `line ${index} description`, 500);
    const quantity = integer(line.quantity, `line ${index} quantity`, 1, 1_000_000);
    const unitPriceCents = integer(line.unitPriceCents, `line ${index} unitPriceCents`, 0, 10_000_000_000);
    const total = quantity * unitPriceCents;
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(subtotalCents + total)) {
      throw new Error("quote money total exceeds safe integer bounds");
    }
    subtotalCents += total;
    return { description, quantity, unitPriceCents };
  });
  return { lines: validated, subtotalCents };
}

function validateArtifacts(value: QuoteArtifacts | undefined, maximum: number): QuoteArtifacts {
  if (!value || typeof value !== "object") throw new Error("PDF and Excel artifacts are required");
  for (const name of ARTIFACT_NAMES) {
    const bytes = value[name];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximum) {
      throw new Error(`${name} artifact exceeded valid byte bounds`);
    }
  }
  return value;
}

export class QuoteDocumentWorkflow {
  private readonly maxDocumentBytes: number;
  private readonly maxLines: number;
  private readonly maxArtifactBytes: number;
  private readonly operationTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly leaseMs: number;

  public constructor(
    private readonly store: QuoteWorkflowStore,
    private readonly extractor: QuoteExtractor,
    private readonly renderer: QuoteRenderer,
    private readonly delivery: QuoteDelivery,
    options: QuoteDocumentWorkflowOptions = {},
  ) {
    this.maxDocumentBytes = integer(options.maxDocumentBytes ?? 25_000_000, "maxDocumentBytes", 1, 100_000_000);
    this.maxLines = integer(options.maxLines ?? 2_000, "maxLines", 1, 10_000);
    this.maxArtifactBytes = integer(options.maxArtifactBytes ?? 25_000_000, "maxArtifactBytes", 1, 100_000_000);
    this.operationTimeoutMs = integer(options.operationTimeoutMs ?? 30_000, "operationTimeoutMs", 1, 300_000);
    this.totalTimeoutMs = integer(options.totalTimeoutMs ?? 120_000, "totalTimeoutMs", 1, 900_000);
    this.leaseMs = integer(options.leaseMs ?? 60_000, "leaseMs", 1_000, 900_000);
    if (this.operationTimeoutMs >= this.leaseMs) throw new Error("operationTimeoutMs must be shorter than leaseMs");
    if (this.totalTimeoutMs < this.operationTimeoutMs) throw new Error("totalTimeoutMs must cover one operation");
  }

  public async prepare(tenantId: string, jobId: string, document: QuoteDocument): Promise<QuoteJobSnapshot> {
    return this.total("quote preparation", async (budget) => {
      const tenant = text(tenantId, "tenantId", 200);
      const id = text(jobId, "jobId", 200);
      if (!document || typeof document !== "object") throw new Error("document is required");
      const name = text(document.name, "document.name", 255);
      if (!["application/pdf", "image/png", "image/jpeg"].includes(document.mimeType)) {
        throw new Error("document.mimeType is unsupported");
      }
      if (!(document.content instanceof Uint8Array) || document.content.byteLength < 1 ||
          document.content.byteLength > this.maxDocumentBytes) {
        throw new Error("document content exceeded valid byte bounds");
      }
      // Copy before hashing or awaiting so caller mutation cannot change provider input.
      const content = Uint8Array.from(document.content);
      const requestHash = key("quote-request", [tenant, id, name, document.mimeType, digest(content)]);
      const claim = await this.storeCall(
        budget,
        (signal) => this.store.claimPreparation(tenant, id, requestHash, this.leaseMs, { signal }),
        "claim preparation",
      );
      if (claim.kind === "existing") {
        this.validateSnapshot(claim.snapshot, tenant, id, requestHash);
        return claim.snapshot;
      }
      if (claim.kind === "busy") throw new Error("quote job is already processing");
      return this.withLease(budget, tenant, id, claim.fence, async () => {
        const quote = validateQuote(await this.call(
          budget,
          (signal) => this.extractor.extract({
            document: { name, mimeType: document.mimeType, content },
            idempotencyKey: key("quote-extraction", [tenant, id, requestHash]),
            signal,
            maxLines: this.maxLines,
          }),
          "quote extraction",
        ), this.maxLines);
        const artifacts = validateArtifacts(await this.call(
          budget,
          (signal) => this.renderer.render({
            quote,
            idempotencyKey: key("quote-render", [tenant, id, requestHash]),
            signal,
            maxArtifactBytes: this.maxArtifactBytes,
          }),
          "quote rendering",
        ), this.maxArtifactBytes);
        const saved = await this.storeCall(
          budget,
          (signal) => this.store.savePrepared(tenant, id, claim.fence, quote, artifacts, { signal }),
          "save prepared quote",
        );
        this.validateSnapshot(saved, tenant, id, requestHash, "pending_approval", quote, artifacts);
        return saved;
      });
    });
  }

  public async approve(tenantId: string, jobId: string, approvalId: string): Promise<QuoteJobSnapshot> {
    return this.total("quote approval", async (budget) => {
      const tenant = text(tenantId, "tenantId", 200);
      const id = text(jobId, "jobId", 200);
      const approval = text(approvalId, "approvalId", 200);
      const snapshot = await this.storeCall(
        budget,
        (signal) => this.store.approveOnce(tenant, id, approval, { signal }),
        "approve quote",
      );
      this.validateSnapshot(snapshot, tenant, id, snapshot.requestHash);
      if (!["approved", "delivering", "delivered"].includes(snapshot.state) || snapshot.approvalId !== approval) {
        throw new Error("quote job is not approved");
      }
      return snapshot;
    });
  }

  public async deliver(
    tenantId: string,
    jobId: string,
    approvalId: string,
    recipient: string,
  ): Promise<QuoteJobSnapshot> {
    return this.total("quote delivery", async (budget) => {
      const tenant = text(tenantId, "tenantId", 200);
      const id = text(jobId, "jobId", 200);
      const approval = text(approvalId, "approvalId", 200);
      const email = text(recipient, "recipient", 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("recipient is invalid");
      const approved = await this.storeCall(
        budget,
        (signal) => this.store.approveOnce(tenant, id, approval, { signal }),
        "load approved quote",
      );
      this.validateSnapshot(approved, tenant, id, approved.requestHash);
      if (!["approved", "delivering", "delivered"].includes(approved.state) ||
          approved.approvalId !== approval || !approved.artifacts) {
        throw new Error("approved quote artifacts are unavailable");
      }
      const artifacts = validateArtifacts(approved.artifacts, this.maxArtifactBytes);
      const deliveryHash = key("quote-delivery-request", [
        tenant, id, approval, email, digest(artifacts.pdf), digest(artifacts.xlsx),
      ]);
      const claim = await this.storeCall(
        budget,
        (signal) => this.store.claimDelivery(
          tenant, id, approval, deliveryHash, this.leaseMs, { signal },
        ),
        "claim delivery",
      );
      if (claim.kind === "existing") {
        this.validateSnapshot(claim.snapshot, tenant, id, approved.requestHash, "delivered");
        if (claim.snapshot.deliveryRequestHash !== deliveryHash || claim.snapshot.approvalId !== approval) {
          throw new Error("delivery request hash mismatch");
        }
        return claim.snapshot;
      }
      if (claim.kind === "busy") throw new Error("quote delivery is already processing");
      return this.withLease(budget, tenant, id, claim.fence, async () => {
        const result = await this.call(
          budget,
          (signal) => this.delivery.deliver({
            recipient: email,
            artifacts,
            idempotencyKey: key("quote-delivery", [tenant, id, deliveryHash]),
            signal,
          }),
          "quote delivery",
        );
        const deliveryId = text(result?.deliveryId, "deliveryId", 500);
        const saved = await this.storeCall(
          budget,
          (signal) => this.store.saveDelivered(tenant, id, claim.fence, deliveryHash, deliveryId, { signal }),
          "save delivered quote",
        );
        this.validateSnapshot(saved, tenant, id, approved.requestHash, "delivered");
        if (saved.approvalId !== approval || saved.deliveryRequestHash !== deliveryHash || saved.deliveryId !== deliveryId) {
          throw new Error("store returned mismatched delivery state");
        }
        return saved;
      });
    });
  }

  private validateSnapshot(
    snapshot: QuoteJobSnapshot,
    tenantId: string,
    jobId: string,
    requestHash: string,
    state?: QuoteJobState,
    quote?: ValidatedQuote,
    artifacts?: QuoteArtifacts,
  ): void {
    if (!snapshot || typeof snapshot !== "object" || snapshot.tenantId !== tenantId ||
        snapshot.jobId !== jobId || snapshot.requestHash !== requestHash || (state && snapshot.state !== state)) {
      throw new Error("store returned a malformed or cross-tenant quote snapshot");
    }
    if (!/^quote-request:v2:[a-f0-9]{64}$/.test(snapshot.requestHash) ||
        !["processing", "pending_approval", "approved", "delivering", "delivered"].includes(snapshot.state)) {
      throw new Error("store returned a malformed quote snapshot");
    }
    if (snapshot.state !== "processing" && (!snapshot.quote || !snapshot.artifacts)) {
      throw new Error("persisted quote snapshot omitted quote artifacts");
    }
    if (["approved", "delivering", "delivered"].includes(snapshot.state) &&
        (typeof snapshot.approvalId !== "string" || !snapshot.approvalId)) {
      throw new Error("persisted quote snapshot omitted approval");
    }
    if (snapshot.state === "delivered" &&
        (!/^quote-delivery-request:v2:[a-f0-9]{64}$/.test(snapshot.deliveryRequestHash ?? "") ||
         typeof snapshot.deliveryId !== "string" || !snapshot.deliveryId)) {
      throw new Error("persisted quote snapshot omitted delivery state");
    }
    if (snapshot.quote) {
      const validated = validateQuote(snapshot.quote.lines, this.maxLines);
      if (validated.subtotalCents !== snapshot.quote.subtotalCents) throw new Error("persisted quote total is invalid");
    }
    if (snapshot.artifacts) validateArtifacts(snapshot.artifacts, this.maxArtifactBytes);
    if (quote && JSON.stringify(snapshot.quote) !== JSON.stringify(quote)) throw new Error("persisted quote did not match");
    if (artifacts && (!snapshot.artifacts ||
        !ARTIFACT_NAMES.every((name) => digest(snapshot.artifacts![name]) === digest(artifacts[name])))) {
      throw new Error("persisted artifacts did not match");
    }
  }

  private async withLease<T>(
    budget: AbortSignal,
    tenantId: string,
    jobId: string,
    fence: number,
    work: () => Promise<T>,
  ): Promise<T> {
    let active = true;
    let rejectLease: (error: Error) => void = () => {};
    const lost = new Promise<never>((_resolve, reject) => { rejectLease = reject; });
    const heartbeat = setInterval(async () => {
      if (!active) return;
      try {
        const renewed = await this.storeCall(
          budget,
          (signal) => this.store.renewLease(tenantId, jobId, fence, this.leaseMs, { signal }),
          "renew quote lease",
        );
        if (!renewed) rejectLease(new Error("quote lease was lost"));
      } catch (error) {
        rejectLease(error instanceof Error ? error : new Error(String(error)));
      }
    }, Math.max(250, Math.floor(this.leaseMs / 3)));
    try {
      return await Promise.race([work(), lost]);
    } finally {
      active = false;
      clearInterval(heartbeat);
    }
  }

  private async total<T>(label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out`)), this.totalTimeoutMs);
    try {
      return await Promise.race([
        work(controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private call<T>(
    budget: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    label: string,
  ): Promise<T> {
    return this.deadline(budget, operation, label);
  }

  private storeCall<T>(
    budget: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    label: string,
  ): Promise<T> {
    return this.deadline(budget, operation, label);
  }

  private async deadline<T>(
    budget: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    label: string,
  ): Promise<T> {
    const controller = new AbortController();
    const relay = () => controller.abort(budget.reason);
    if (budget.aborted) {
      controller.abort(budget.reason);
      throw budget.reason;
    }
    budget.addEventListener("abort", relay, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} timed out`));
      }, this.operationTimeoutMs);
    });
    try {
      return await Promise.race([operation(controller.signal), expired]);
    } finally {
      if (timeout) clearTimeout(timeout);
      budget.removeEventListener("abort", relay);
    }
  }
}
