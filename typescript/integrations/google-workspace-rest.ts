/**
 * Dependency-free Google Drive and Sheets REST client.
 *
 * OAuth credentials and transport are injected so this module never reads,
 * stores, or logs secrets. One client instance caches and coalesces refreshes.
 */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface GoogleWorkspaceRestOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

export interface DriveFolder {
  id: string;
  name: string;
}

export interface SheetValueRange {
  range: string;
  values: unknown[][];
}

export type UploadContent = string | Blob | ArrayBuffer | Uint8Array<ArrayBuffer>;

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ERROR_LIMIT = 500;
const TOKEN_SKEW_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN_RESPONSE_BYTES = 64_000;
const API_RESPONSE_BYTES = 1_000_000;
const MAX_DRIVE_ID_CHARS = 128;
const MAX_DRIVE_NAME_CHARS = 255;
const MAX_DRIVE_PARENTS = 100;
const MAX_CONTENT_TYPE_CHARS = 255;
const MAX_UPLOAD_METADATA_BYTES = 64_000;
const MAX_UPLOAD_BYTES = 100_000_000;
const MAX_SHEET_RANGES = 100;
const MAX_SHEET_ROWS = 10_000;
const MAX_SHEET_CELLS = 50_000;
const MAX_SHEET_REQUEST_BYTES = 5_000_000;
const GOOGLE_UPLOAD_ORIGINS = new Set([
  "https://www.googleapis.com",
  "https://content.googleapis.com",
]);

function required(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function bounded(value: string, name: string, maximum: number): string {
  required(value, name);
  if (value.length > maximum) throw new RangeError(`${name} cannot exceed ${maximum} characters`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function encodePath(value: string): string {
  return encodeURIComponent(required(value, "path value"));
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export class GoogleApiError extends Error {
  public constructor(
    public readonly status: number,
    statusText: string,
    body: string
  ) {
    super(
      `Google API request failed (${status} ${statusText})${body ? `: ${body}` : ""}`
    );
    this.name = "GoogleApiError";
  }
}

async function readBounded(
  response: Response,
  maximum: number,
  timeoutMs: number,
  truncate: boolean
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (!truncate && declared !== null && Number(declared) > maximum) {
    void response.body?.cancel().catch(() => {});
    throw new RangeError(`Google response cannot exceed ${maximum} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const read = reader.read();
      const { done, value } = await Promise.race([
        read,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`Google response timed out after ${timeoutMs}ms`));
            void reader.cancel(new Error("Google response timed out")).catch(() => {});
          }, timeoutMs);
        }),
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });
      if (done) break;
      const remaining = maximum - total;
      if (value.byteLength > remaining) {
        if (!truncate) {
          void reader.cancel().catch(() => {});
          throw new RangeError(`Google response cannot exceed ${maximum} bytes`);
        }
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        total = maximum;
        void reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readJson(response: Response, maximum: number, timeoutMs: number): Promise<unknown> {
  const bytes = await readBounded(response, maximum, timeoutMs, false);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Google response was not valid JSON");
  }
}

async function googleError(response: Response, timeoutMs: number): Promise<GoogleApiError> {
  const body = new TextDecoder().decode(await readBounded(response, ERROR_LIMIT, timeoutMs, true));
  return new GoogleApiError(response.status, response.statusText, body);
}

function uploadByteLength(content: UploadContent): number {
  if (typeof content === "string") return new TextEncoder().encode(content).byteLength;
  if (content instanceof Blob) return content.size;
  if (content instanceof ArrayBuffer) return content.byteLength;
  return content.byteLength;
}

function snapshotUploadContent(content: UploadContent): UploadContent {
  if (content instanceof ArrayBuffer) return content.slice(0);
  if (content instanceof Uint8Array) return new Uint8Array(content);
  return content;
}

function validateSheetData(data: SheetValueRange[]): void {
  if (data.length === 0 || data.length > MAX_SHEET_RANGES) {
    throw new RangeError(`data must contain 1 to ${MAX_SHEET_RANGES} ranges`);
  }
  let rows = 0;
  let cells = 0;
  for (const item of data) {
    required(item?.range, "data range");
    if (!Array.isArray(item.values) || item.values.some((row) => !Array.isArray(row))) {
      throw new TypeError("each data.values must be an array of row arrays");
    }
    rows += item.values.length;
    cells += item.values.reduce((sum, row) => sum + row.length, 0);
  }
  if (rows > MAX_SHEET_ROWS) throw new RangeError(`values cannot exceed ${MAX_SHEET_ROWS} rows`);
  if (cells > MAX_SHEET_CELLS) throw new RangeError(`values cannot exceed ${MAX_SHEET_CELLS} cells`);
}

function boundedSheetBody(value: unknown): string {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > MAX_SHEET_REQUEST_BYTES) {
    throw new RangeError(`Sheets request cannot exceed ${MAX_SHEET_REQUEST_BYTES} bytes`);
  }
  return body;
}

function validateSheetRequestSize(url: string, body = ""): void {
  if (new TextEncoder().encode(url + body).byteLength > MAX_SHEET_REQUEST_BYTES) {
    throw new RangeError(`Sheets request cannot exceed ${MAX_SHEET_REQUEST_BYTES} bytes`);
  }
}

export class GoogleWorkspaceRestClient {
  private accessToken: string | undefined;
  private expiresAtMs = 0;
  private refreshInFlight: Promise<string> | undefined;
  private readonly folderInFlight = new Map<string, Promise<DriveFolder>>();
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  public constructor(private readonly options: GoogleWorkspaceRestOptions) {
    required(options.clientId, "clientId");
    required(options.clientSecret, "clientSecret");
    required(options.refreshToken, "refreshToken");
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.fetcher(url, { ...init, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`Google request timed out after ${this.timeoutMs}ms`));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.now() + TOKEN_SKEW_MS < this.expiresAtMs) {
      return this.accessToken;
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshToken().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async refreshToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      refresh_token: this.options.refreshToken,
      grant_type: "refresh_token",
    });
    const response = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw await googleError(response, this.timeoutMs);

    const payload = await readJson(response, TOKEN_RESPONSE_BYTES, this.timeoutMs);
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as { access_token?: unknown }).access_token !== "string" ||
      typeof (payload as { expires_in?: unknown }).expires_in !== "number"
    ) {
      throw new Error("Google token response was malformed");
    }
    const token = (payload as { access_token: string }).access_token;
    const expiresIn = positiveInteger(
      (payload as { expires_in: number }).expires_in,
      "expires_in"
    );
    const now = this.now();
    const lifetimeMs = expiresIn * 1000;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(lifetimeMs) ||
        !Number.isSafeInteger(now + lifetimeMs)) {
      throw new Error("Google token expiry was outside the safe integer range");
    }
    this.accessToken = required(token, "access_token");
    this.expiresAtMs = now + lifetimeMs;
    return this.accessToken;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const send = async (): Promise<{ response: Response; token: string }> => {
      const token = await this.token();
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return { response: await this.fetch(url, { ...init, headers }), token };
    };
    let { response, token } = await send();
    if (response.status === 401) {
      void response.body?.cancel().catch(() => {});
      if (this.accessToken === token) {
        this.accessToken = undefined;
        this.expiresAtMs = 0;
      }
      ({ response, token } = await send());
    }
    if (!response.ok) throw await googleError(response, this.timeoutMs);
    return response;
  }

  public async findSharedDriveFolder(
    driveId: string,
    parentId: string,
    name: string
  ): Promise<DriveFolder | null> {
    bounded(driveId, "driveId", MAX_DRIVE_ID_CHARS);
    bounded(parentId, "parentId", MAX_DRIVE_ID_CHARS);
    bounded(name, "name", MAX_DRIVE_NAME_CHARS);
    const query = [
      `'${escapeDriveQuery(parentId)}' in parents`,
      `name = '${escapeDriveQuery(name)}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
    ].join(" and ");
    const params = new URLSearchParams({
      q: query,
      corpora: "drive",
      driveId,
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      fields: "files(id,name)",
      pageSize: "2",
    });
    const payload = await readJson(
      await this.request(`${DRIVE_API}/files?${params}`),
      API_RESPONSE_BYTES,
      this.timeoutMs
    );
    const files = (payload as { files?: unknown }).files;
    if (!Array.isArray(files) || files.length === 0) return null;
    const first = files[0] as { id?: unknown; name?: unknown };
    if (typeof first.id !== "string" || typeof first.name !== "string") {
      throw new Error("Google Drive folder response was malformed");
    }
    return {
      id: bounded(first.id, "folder id", MAX_DRIVE_ID_CHARS),
      name: bounded(first.name, "folder name", MAX_DRIVE_NAME_CHARS),
    };
  }

  public async createSharedDriveFolder(
    driveId: string,
    parentId: string,
    name: string
  ): Promise<DriveFolder> {
    bounded(driveId, "driveId", MAX_DRIVE_ID_CHARS);
    bounded(parentId, "parentId", MAX_DRIVE_ID_CHARS);
    bounded(name, "name", MAX_DRIVE_NAME_CHARS);
    const params = new URLSearchParams({
      supportsAllDrives: "true",
      fields: "id,name",
    });
    const response = await this.request(`${DRIVE_API}/files?${params}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        parents: [parentId],
        mimeType: "application/vnd.google-apps.folder",
      }),
    });
    const folder = await readJson(response, API_RESPONSE_BYTES, this.timeoutMs);
    if (
      typeof folder !== "object" ||
      folder === null ||
      typeof (folder as DriveFolder).id !== "string" ||
      typeof (folder as DriveFolder).name !== "string"
    ) {
      throw new Error("Google Drive create response was malformed");
    }
    return {
      id: bounded((folder as DriveFolder).id, "folder id", MAX_DRIVE_ID_CHARS),
      name: bounded((folder as DriveFolder).name, "folder name", MAX_DRIVE_NAME_CHARS),
    };
  }

  public async findOrCreateSharedDriveFolder(
    driveId: string,
    parentId: string,
    name: string
  ): Promise<DriveFolder> {
    bounded(driveId, "driveId", MAX_DRIVE_ID_CHARS);
    bounded(parentId, "parentId", MAX_DRIVE_ID_CHARS);
    bounded(name, "name", MAX_DRIVE_NAME_CHARS);
    const key = JSON.stringify([driveId, parentId, name]);
    const existing = this.folderInFlight.get(key);
    if (existing) return existing;
    const operation = (async () =>
      (await this.findSharedDriveFolder(driveId, parentId, name)) ??
      this.createSharedDriveFolder(driveId, parentId, name))();
    this.folderInFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.folderInFlight.delete(key);
    }
  }

  /** Uses a resumable session for one exact-length PUT; callers retry the method as a new session. */
  public async uploadFileViaResumableSession(
    metadata: { name: string; parents?: string[] },
    content: UploadContent,
    contentType: string,
    contentLength: number
  ): Promise<{ id: string }> {
    bounded(metadata.name, "metadata.name", MAX_DRIVE_NAME_CHARS);
    bounded(contentType, "contentType", MAX_CONTENT_TYPE_CHARS);
    nonNegativeInteger(contentLength, "contentLength");
    const contentSnapshot = snapshotUploadContent(content);
    if (contentLength > MAX_UPLOAD_BYTES) {
      throw new RangeError(`contentLength cannot exceed ${MAX_UPLOAD_BYTES} bytes`);
    }
    if (uploadByteLength(contentSnapshot) !== contentLength) {
      throw new RangeError("contentLength must exactly match the content byte length");
    }
    if (metadata.parents && metadata.parents.length > MAX_DRIVE_PARENTS) {
      throw new RangeError(`metadata.parents cannot exceed ${MAX_DRIVE_PARENTS} items`);
    }
    metadata.parents?.forEach((id) => bounded(id, "parent id", MAX_DRIVE_ID_CHARS));
    const metadataBody = JSON.stringify({
      name: metadata.name,
      ...(metadata.parents ? { parents: metadata.parents } : {}),
    });
    if (new TextEncoder().encode(metadataBody).byteLength > MAX_UPLOAD_METADATA_BYTES) {
      throw new RangeError(`upload metadata cannot exceed ${MAX_UPLOAD_METADATA_BYTES} bytes`);
    }
    const session = await this.request(
      `${DRIVE_UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true&fields=id`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-upload-content-type": contentType,
          "x-upload-content-length": String(contentLength),
        },
        body: metadataBody,
      }
    );
    const location = session.headers.get("location");
    if (!location) throw new Error("Google resumable upload response omitted the session URL");
    let uploadUrl: URL;
    try {
      uploadUrl = new URL(location);
    } catch {
      throw new Error("Google resumable upload returned an invalid session URL");
    }
    if (
      uploadUrl.protocol !== "https:" ||
      !GOOGLE_UPLOAD_ORIGINS.has(uploadUrl.origin) ||
      !uploadUrl.pathname.startsWith("/upload/drive/")
    ) {
      throw new Error("Google resumable upload returned an unapproved session URL");
    }
    const uploaded = await this.request(uploadUrl.toString(), {
      method: "PUT",
      headers: {
        "content-type": contentType,
        "content-length": String(contentLength),
      },
      body: contentSnapshot,
    });
    const payload = await readJson(uploaded, API_RESPONSE_BYTES, this.timeoutMs);
    const id = (payload as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") {
      throw new Error("Google upload response was malformed");
    }
    return { id: bounded(id, "uploaded file id", MAX_DRIVE_ID_CHARS) };
  }

  public async deleteDriveFile(fileId: string): Promise<void> {
    bounded(fileId, "fileId", MAX_DRIVE_ID_CHARS);
    try {
      const response = await this.request(
        `${DRIVE_API}/files/${encodePath(fileId)}?supportsAllDrives=true`,
        { method: "DELETE" }
      );
      void response.body?.cancel().catch(() => {});
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) return;
      throw error;
    }
  }

  public async updateSheetValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][]
  ): Promise<unknown> {
    required(spreadsheetId, "spreadsheetId");
    required(range, "range");
    validateSheetData([{ range, values }]);
    const body = boundedSheetBody({ range, majorDimension: "ROWS", values });
    const url = `${SHEETS_API}/${encodePath(spreadsheetId)}/values/${encodePath(range)}?valueInputOption=RAW`;
    validateSheetRequestSize(url, body);
    return readJson(await this.request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    }), API_RESPONSE_BYTES, this.timeoutMs);
  }

  public async clearSheetValues(spreadsheetId: string, range: string): Promise<unknown> {
    required(spreadsheetId, "spreadsheetId");
    required(range, "range");
    const url = `${SHEETS_API}/${encodePath(spreadsheetId)}/values/${encodePath(range)}:clear`;
    validateSheetRequestSize(url, "{}");
    return readJson(await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), API_RESPONSE_BYTES, this.timeoutMs);
  }

  public async batchUpdateSheetValues(
    spreadsheetId: string,
    data: SheetValueRange[]
  ): Promise<unknown> {
    required(spreadsheetId, "spreadsheetId");
    validateSheetData(data);
    const body = boundedSheetBody({ valueInputOption: "RAW", data });
    const url = `${SHEETS_API}/${encodePath(spreadsheetId)}/values:batchUpdate`;
    validateSheetRequestSize(url, body);
    return readJson(await this.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }
    ), API_RESPONSE_BYTES, this.timeoutMs);
  }
}
