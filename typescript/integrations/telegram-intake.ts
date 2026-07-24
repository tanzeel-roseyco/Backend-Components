import { createHash, timingSafeEqual } from "node:crypto";

export interface TelegramDocumentDescriptor {
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly fileSize?: number;
}

export interface TelegramCommand {
  readonly name: string;
  readonly botUsername?: string;
  readonly arguments: string;
}

export type TelegramAcceptedUpdate =
  | {
      readonly kind: "text";
      readonly updateId: number;
      readonly messageId: number;
      readonly date: number;
      readonly chatId: number;
      readonly userId: number;
      readonly text: string;
      readonly command: TelegramCommand | null;
    }
  | {
      readonly kind: "document";
      readonly updateId: number;
      readonly messageId: number;
      readonly date: number;
      readonly chatId: number;
      readonly userId: number;
      readonly caption?: string;
      readonly document: TelegramDocumentDescriptor;
    };

export interface TelegramUpdateStore {
  /**
   * Atomically inserts or reads by botId + integrationId + updateId.
   * Existing rows with a different fingerprint must be rejected by the store.
   */
  insertOrRead(
    input: TelegramPersistedUpdate,
    signal: AbortSignal
  ): Promise<{ readonly created: boolean; readonly record: TelegramPersistedUpdate }>;
}

export interface TelegramPersistedUpdate {
  readonly botId: string;
  readonly integrationId: string;
  readonly updateId: number;
  readonly fingerprint: string;
  readonly update: TelegramAcceptedUpdate;
}

export interface TelegramIntakeOptions {
  readonly botId: string;
  readonly integrationId: string;
  readonly secretToken: string;
  readonly allowedChatIds: readonly number[];
  readonly allowedUserIds: readonly number[];
  readonly store: TelegramUpdateStore;
  readonly maxJsonBytes?: number;
  readonly maxDocumentBytes?: number;
  readonly timeoutMs?: number;
}

export interface TelegramIntakeResult {
  readonly accepted: boolean;
  readonly replayed: boolean;
  readonly update: TelegramAcceptedUpdate;
}

export class TelegramIntakeError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "TelegramIntakeError";
  }
}

const DEFAULT_JSON_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ALLOWLIST_IDS = 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_NAMESPACE_CHARS = 128;
const MAX_TEXT_CHARS = 4_096;
const MAX_CAPTION_CHARS = 1_024;
const MAX_FILE_TOKEN_CHARS = 512;
const MAX_FILE_NAME_CHARS = 255;
const MAX_MIME_CHARS = 255;
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;
const FILE_TOKEN_RE = /^[A-Za-z0-9_-]{1,512}$/;
const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,32}))?(?:\s+([\s\S]*))?$/;

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TelegramIntakeError(400, `${name} must be a positive safe integer`);
  }
  return value;
}

function signedInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value === 0) {
    throw new TelegramIntakeError(400, `${name} must be a non-zero safe integer`);
  }
  return value;
}

function bounded(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TelegramIntakeError(400, `${name} must be a non-empty string`);
  }
  if (value.length > maximum) {
    throw new TelegramIntakeError(413, `${name} cannot exceed ${maximum} characters`);
  }
  return value;
}

function optionalBounded(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return bounded(value, name, maximum);
}

function fileToken(value: unknown, name: string): string {
  const token = bounded(value, name, MAX_FILE_TOKEN_CHARS);
  if (!FILE_TOKEN_RE.test(token)) throw new TelegramIntakeError(400, `${name} is invalid`);
  return token;
}

function fileName(value: unknown): string | undefined {
  const name = optionalBounded(value, "message.document.file_name", MAX_FILE_NAME_CHARS);
  if (name !== undefined && (/[/\\]/.test(name) || /[\u0000-\u001f\u007f]/.test(name))) {
    throw new TelegramIntakeError(400, "message.document.file_name is invalid");
  }
  return name;
}

function mimeType(value: unknown): string | undefined {
  const mime = optionalBounded(value, "message.document.mime_type", MAX_MIME_CHARS);
  if (mime !== undefined && !MIME_RE.test(mime)) {
    throw new TelegramIntakeError(400, "message.document.mime_type is invalid");
  }
  return mime;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TelegramIntakeError(400, `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null || provided.length > 256) return false;
  const suppliedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  ).join(",")}}`;
}

function updateFingerprint(update: TelegramAcceptedUpdate): string {
  return createHash("sha256").update(canonicalJson(update)).digest("hex");
}

function allowlist(values: readonly number[], name: string, signed = false): Set<number> {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_ALLOWLIST_IDS) {
    throw new TelegramIntakeError(500, `${name} must contain 1 to ${MAX_ALLOWLIST_IDS} IDs`);
  }
  const result = new Set<number>();
  for (const value of values) {
    result.add(signed ? signedInteger(value, name) : positiveInteger(value, name));
  }
  return result;
}

function namespace(value: string, name: string): string {
  const result = bounded(value, name, MAX_NAMESPACE_CHARS);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) {
    throw new TelegramIntakeError(500, `${name} must contain only letters, digits, underscore, or hyphen`);
  }
  return result;
}

function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new TelegramIntakeError(408, "Telegram intake deadline exceeded"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new TelegramIntakeError(408, "Telegram intake deadline exceeded"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new TelegramIntakeError(408, "Telegram intake deadline exceeded");
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readJsonBytes(
  request: Request,
  maximum: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new TelegramIntakeError(413, `Telegram update cannot exceed ${maximum} bytes`);
  }
  if (!request.body) throw new TelegramIntakeError(400, "Telegram update body is required");
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(() => reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        void reader.cancel().catch(() => {});
        throw new TelegramIntakeError(413, `Telegram update cannot exceed ${maximum} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (total === 0) throw new TelegramIntakeError(400, "Telegram update body is required");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function parseTelegramCommand(text: string): TelegramCommand | null {
  bounded(text, "text", MAX_TEXT_CHARS);
  const match = COMMAND_RE.exec(text);
  if (!match) return null;
  return Object.freeze({
    name: match[1].toLowerCase(),
    ...(match[2] ? { botUsername: match[2].toLowerCase() } : {}),
    arguments: (match[3] ?? "").trim(),
  });
}

function parseUpdate(
  value: unknown,
  allowedChats: ReadonlySet<number>,
  allowedUsers: ReadonlySet<number>,
  maxDocumentBytes: number
): TelegramAcceptedUpdate {
  const update = record(value, "update");
  const updateId = positiveInteger(update.update_id as number, "update_id");
  const message = record(update.message, "message");
  const messageId = positiveInteger(message.message_id as number, "message_id");
  const date = positiveInteger(message.date as number, "message.date");
  const chat = record(message.chat, "message.chat");
  const from = record(message.from, "message.from");
  const chatId = signedInteger(chat.id as number, "message.chat.id");
  const userId = positiveInteger(from.id as number, "message.from.id");
  if (!allowedChats.has(chatId) || !allowedUsers.has(userId)) {
    throw new TelegramIntakeError(403, "Telegram chat or user is not authorized");
  }

  if (message.text !== undefined && message.document !== undefined) {
    throw new TelegramIntakeError(400, "message cannot contain both text and document");
  }
  if (message.text !== undefined) {
    const text = bounded(message.text, "message.text", MAX_TEXT_CHARS);
    return Object.freeze({
      kind: "text",
      updateId,
      messageId,
      date,
      chatId,
      userId,
      text,
      command: parseTelegramCommand(text),
    });
  }
  if (message.document !== undefined) {
    const document = record(message.document, "message.document");
    const fileSize = document.file_size === undefined
      ? undefined
      : positiveInteger(document.file_size as number, "message.document.file_size");
    if (fileSize !== undefined && fileSize > maxDocumentBytes) {
      throw new TelegramIntakeError(413, `document cannot exceed ${maxDocumentBytes} bytes`);
    }
    const descriptor = Object.freeze({
      fileId: fileToken(document.file_id, "message.document.file_id"),
      fileUniqueId: fileToken(document.file_unique_id, "message.document.file_unique_id"),
      ...(fileName(document.file_name) ? { fileName: document.file_name as string } : {}),
      ...(mimeType(document.mime_type) ? { mimeType: document.mime_type as string } : {}),
      ...(fileSize === undefined ? {} : { fileSize }),
    });
    const caption = optionalBounded(message.caption, "message.caption", MAX_CAPTION_CHARS);
    return Object.freeze({
      kind: "document",
      updateId,
      messageId,
      date,
      chatId,
      userId,
      ...(caption === undefined ? {} : { caption }),
      document: descriptor,
    });
  }
  throw new TelegramIntakeError(400, "message must contain text or document");
}

export async function intakeTelegramWebhook(
  request: Request,
  options: TelegramIntakeOptions
): Promise<TelegramIntakeResult> {
  if (request.method !== "POST") throw new TelegramIntakeError(405, "Telegram webhook requires POST");
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new TelegramIntakeError(415, "Telegram webhook requires application/json");
  }
  if (!SECRET_RE.test(options.secretToken)) {
    throw new TelegramIntakeError(500, "secretToken is invalid");
  }
  if (!secretMatches(request.headers.get("x-telegram-bot-api-secret-token"), options.secretToken)) {
    throw new TelegramIntakeError(401, "invalid Telegram webhook secret");
  }
  const botId = namespace(options.botId, "botId");
  const integrationId = namespace(options.integrationId, "integrationId");
  const maximum = positiveInteger(options.maxJsonBytes ?? DEFAULT_JSON_BYTES, "maxJsonBytes", MAX_JSON_BYTES);
  const maxDocumentBytes = positiveInteger(
    options.maxDocumentBytes ?? DEFAULT_DOCUMENT_BYTES,
    "maxDocumentBytes",
    MAX_DOCUMENT_BYTES
  );
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    MAX_TIMEOUT_MS
  );
  const allowedChats = allowlist(options.allowedChatIds, "allowedChatIds", true);
  const allowedUsers = allowlist(options.allowedUserIds, "allowedUserIds");
  const deadline = new AbortController();
  const forwardAbort = () => deadline.abort();
  if (request.signal.aborted) deadline.abort();
  else request.signal.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        await readJsonBytes(request, maximum, deadline.signal)
      ));
    } catch (error) {
      if (error instanceof TelegramIntakeError) throw error;
      throw new TelegramIntakeError(400, "Telegram update must be valid UTF-8 JSON");
    }
    const update = parseUpdate(parsed, allowedChats, allowedUsers, maxDocumentBytes);
    const persisted: TelegramPersistedUpdate = Object.freeze({
      botId,
      integrationId,
      updateId: update.updateId,
      fingerprint: updateFingerprint(update),
      update,
    });
    const result = await withAbort(
      () => options.store.insertOrRead(persisted, deadline.signal),
      deadline.signal
    );
    if (
      !result ||
      typeof result.created !== "boolean" ||
      result.record?.botId !== botId ||
      result.record?.integrationId !== integrationId ||
      result.record?.updateId !== update.updateId ||
      result.record?.fingerprint !== persisted.fingerprint ||
      typeof result.record?.update !== "object" ||
      result.record.update === null ||
      updateFingerprint(result.record?.update) !== result.record.fingerprint
    ) {
      throw new TelegramIntakeError(409, "persisted Telegram update conflicts with this delivery");
    }
    return { accepted: result.created, replayed: !result.created, update: result.record.update };
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", forwardAbort);
  }
}
