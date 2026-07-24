import { createHash } from "node:crypto";

export interface SignedDocumentDescriptor {
  readonly documentId: string;
  readonly name: string;
  readonly mimeType?: string;
}

export interface SignedDocumentProvider {
  readonly listDocuments: (
    envelopeId: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<readonly SignedDocumentDescriptor[]>;
  /**
   * Implementations must stop reading at maxBytes and reject when signal aborts.
   * The processor verifies the returned size as a second boundary.
   */
  readonly downloadDocument: (
    envelopeId: string,
    documentId: string,
    options: { readonly signal: AbortSignal; readonly maxBytes: number },
  ) => Promise<Uint8Array>;
}

export interface ImmutableArtifact {
  readonly artifactId: string;
  readonly storageKey: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
}

export interface SignedDocumentStore<TState> {
  readonly getCompletion: (
    eventKey: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<ProcessingResult<TState> | null>;
  /**
   * Reusing idempotencyKey with identical bytes returns the original artifact.
   * Reusing it with different bytes must reject rather than overwrite evidence.
   */
  readonly putImmutable: (input: {
    readonly idempotencyKey: string;
    readonly envelopeId: string;
    readonly document: SignedDocumentDescriptor;
    readonly content: Uint8Array;
    readonly checksumSha256: string;
    readonly signal: AbortSignal;
  }) => Promise<ImmutableArtifact>;
  /**
   * Atomically inserts eventKey, its artifacts, and the resulting domain state.
   * A duplicate returns the already-persisted result.
   */
  readonly completeOnce: (input: {
    readonly eventKey: string;
    readonly envelopeId: string;
    readonly transitionIdempotencyKey: string;
    readonly artifacts: readonly ImmutableArtifact[];
    readonly signal: AbortSignal;
  }) => Promise<ProcessingResult<TState>>;
}

export interface SignedDocumentProcessorOptions {
  readonly maxDocuments?: number;
  readonly maxDocumentBytes?: number;
  readonly downloadTimeoutMs?: number;
  readonly maxTotalBytes?: number;
}

export interface ProcessingResult<TState> {
  readonly replayed: boolean;
  readonly artifacts: readonly ImmutableArtifact[];
  readonly state: TState;
}

const DEFAULT_MAX_DOCUMENTS = 100;
const DEFAULT_MAX_DOCUMENT_BYTES = 25_000_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

function boundedText(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  if (value.length > maximum) throw new RangeError(`${name} cannot exceed ${maximum} characters`);
  return value;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function validateDocuments(
  documents: readonly SignedDocumentDescriptor[],
  maximum: number,
): readonly SignedDocumentDescriptor[] {
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > maximum) {
    throw new Error(`documents must contain 1 to ${maximum} items`);
  }
  const ids = new Set<string>();
  return documents.map((document, index) => {
    if (!document || typeof document !== "object") throw new Error(`documents[${index}] is invalid`);
    const documentId = boundedText(document.documentId, `documents[${index}].documentId`, 128);
    if (ids.has(documentId)) throw new Error(`duplicate documentId: ${documentId}`);
    ids.add(documentId);
    const name = boundedText(document.name, `documents[${index}].name`, 255);
    const mimeType = document.mimeType ?? "application/pdf";
    if (mimeType !== "application/pdf") throw new Error(`documents[${index}] must be a PDF`);
    return { documentId, name, mimeType };
  });
}

export class SignedDocumentProcessor<TState> {
  private readonly maxDocuments: number;
  private readonly maxDocumentBytes: number;
  private readonly downloadTimeoutMs: number;
  private readonly maxTotalBytes: number;

  public constructor(
    private readonly provider: SignedDocumentProvider,
    private readonly store: SignedDocumentStore<TState>,
    options: SignedDocumentProcessorOptions = {},
  ) {
    this.maxDocuments = positiveInteger(options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS, "maxDocuments", 1_000);
    this.maxDocumentBytes = positiveInteger(
      options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
      "maxDocumentBytes",
      100_000_000,
    );
    this.downloadTimeoutMs = positiveInteger(
      options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
      "downloadTimeoutMs",
      120_000,
    );
    this.maxTotalBytes = positiveInteger(
      options.maxTotalBytes ?? 100_000_000,
      "maxTotalBytes",
      500_000_000,
    );
  }

  public async process(input: {
    readonly envelopeId: string;
    readonly eventId: string;
  }): Promise<ProcessingResult<TState>> {
    if (!input || typeof input !== "object") throw new TypeError("input is required");
    const envelopeId = boundedText(input.envelopeId, "envelopeId", 128);
    const eventId = boundedText(input.eventId, "eventId", 256);
    const eventKey = stableKey("signed-document-event", [envelopeId, eventId]);
    const existing = await this.withDeadline(
      (signal) => this.store.getCompletion(eventKey, { signal }),
      "load signed-document completion",
    );
    if (existing) {
      validatePersistedResult(existing, eventKey, this.maxDocuments, this.maxTotalBytes);
      return { ...existing, replayed: true };
    }

    const documents = validateDocuments(
      await this.withDeadline(
        (signal) => this.provider.listDocuments(envelopeId, { signal }),
        "list documents",
      ),
      this.maxDocuments,
    );
    const artifacts: ImmutableArtifact[] = [];
    let totalBytes = 0;
    for (const document of documents) {
      const artifactKey = stableKey("signed-document-artifact", [eventKey, document.documentId]);
      const content = await this.download(envelopeId, document);
      totalBytes += content.byteLength;
      if (totalBytes > this.maxTotalBytes) throw new Error("documents exceeded the total byte limit");
      const checksumSha256 = createHash("sha256").update(content).digest("hex");
      const artifact = await this.withDeadline(
        (signal) => this.store.putImmutable({
          idempotencyKey: artifactKey,
          envelopeId,
          document,
          content,
          checksumSha256,
          signal,
        }),
        `store document ${document.documentId}`,
      );
      validateArtifact(artifact, artifactKey, content.byteLength, checksumSha256);
      artifacts.push(artifact);
    }

    const completed = await this.withDeadline(
      (signal) => this.store.completeOnce({
        eventKey,
        envelopeId,
        transitionIdempotencyKey: stableKey("signed-document-transition", [eventKey]),
        artifacts,
        signal,
      }),
      "complete signed-document processing",
    );
    validateCompletedResult(completed, artifacts, eventKey, this.maxTotalBytes);
    return completed;
  }

  private async download(
    envelopeId: string,
    document: SignedDocumentDescriptor,
  ): Promise<Uint8Array> {
    return this.withDeadline(async (signal) => {
      const content = await this.provider.downloadDocument(envelopeId, document.documentId, {
        signal,
        maxBytes: this.maxDocumentBytes,
      });
      if (!(content instanceof Uint8Array)) throw new Error(`download ${document.documentId} returned invalid bytes`);
      if (content.byteLength < 1 || content.byteLength > this.maxDocumentBytes) {
        throw new Error(`download ${document.documentId} exceeded valid size bounds`);
      }
      return content;
    }, `download ${document.documentId}`);
  }

  private async withDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    label: string,
  ): Promise<T> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} timed out`));
      }, this.downloadTimeoutMs);
    });
    try {
      return await Promise.race([operation(controller.signal), deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function validateArtifact(
  artifact: ImmutableArtifact,
  expectedStorageKey: string,
  expectedSize: number,
  expectedChecksum: string,
): void {
  boundedText(artifact?.artifactId, "artifactId", 256);
  if (artifact.storageKey !== expectedStorageKey) throw new Error("artifact storageKey did not match its idempotency key");
  if (artifact.sizeBytes !== expectedSize || artifact.checksumSha256 !== expectedChecksum) {
    throw new Error("artifact metadata did not match downloaded content");
  }
}

function stableKey(namespace: string, parts: readonly string[]): string {
  const framed = parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("|");
  return `${namespace}:v1:${createHash("sha256").update(framed, "utf8").digest("hex")}`;
}

function validatePersistedResult<TState>(
  result: ProcessingResult<TState>,
  eventKey: string,
  maxDocuments: number,
  maxTotalBytes: number,
): void {
  if (!result || typeof result !== "object" || typeof result.replayed !== "boolean" ||
      !Array.isArray(result.artifacts) ||
      result.artifacts.length < 1 || result.artifacts.length > maxDocuments || !("state" in result)) {
    throw new Error(`persisted result for ${eventKey} was malformed`);
  }
  const keys = new Set<string>();
  let total = 0;
  for (const artifact of result.artifacts) {
    boundedText(artifact?.artifactId, "artifactId", 256);
    if (!/^signed-document-artifact:v1:[a-f0-9]{64}$/.test(artifact.storageKey) ||
        !/^[a-f0-9]{64}$/.test(artifact.checksumSha256) ||
        !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 ||
        keys.has(artifact.storageKey)) {
      throw new Error(`persisted result for ${eventKey} contained an invalid artifact`);
    }
    keys.add(artifact.storageKey);
    total += artifact.sizeBytes;
  }
  if (total > maxTotalBytes) throw new Error(`persisted result for ${eventKey} exceeded the total byte limit`);
}

function validateCompletedResult<TState>(
  result: ProcessingResult<TState>,
  submitted: readonly ImmutableArtifact[],
  eventKey: string,
  maxTotalBytes: number,
): void {
  validatePersistedResult(result, eventKey, submitted.length, maxTotalBytes);
  if (result.artifacts.length !== submitted.length ||
      result.artifacts.some((artifact, index) => {
        const expected = submitted[index];
        return artifact.artifactId !== expected.artifactId ||
          artifact.storageKey !== expected.storageKey ||
          artifact.checksumSha256 !== expected.checksumSha256 ||
          artifact.sizeBytes !== expected.sizeBytes;
      })) {
    throw new Error("persisted completion did not match submitted artifacts");
  }
}
