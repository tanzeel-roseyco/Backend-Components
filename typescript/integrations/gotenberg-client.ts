export interface GotenbergOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly maxHtmlBytes?: number;
  readonly maxPdfBytes?: number;
  readonly fetcher?: typeof fetch;
}

export interface PdfRenderOptions {
  readonly marginTop?: string;
  readonly marginBottom?: string;
  readonly marginLeft?: string;
  readonly marginRight?: string;
  readonly paperWidth?: string;
  readonly paperHeight?: string;
}

const PDF_OPTION_KEYS = [
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "paperWidth",
  "paperHeight",
] as const;

const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 100 * 1024 * 1024;

function runWithAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  label: string
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(`${label} timed out`));
  return new Promise<T>((resolve, reject) => {
    const rejectAbort = () => reject(new Error(`${label} timed out`));
    signal.addEventListener("abort", rejectAbort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(
      () => signal.removeEventListener("abort", rejectAbort)
    );
  });
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await runWithAbort(() => reader.read(), signal, "Gotenberg error response");
    if (done) break;
    const remaining = maxBytes - total;
    chunks.push(value.subarray(0, remaining));
    total += Math.min(value.byteLength, remaining);
    if (value.byteLength > remaining || total === maxBytes) {
      void reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Minimal Gotenberg Chromium adapter with bounded requests and explicit failures. */
export class GotenbergClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxHtmlBytes: number;
  private readonly maxPdfBytes: number;
  private readonly fetcher: typeof fetch;

  constructor(options: GotenbergOptions) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Gotenberg baseUrl must use HTTP or HTTPS");
    }
    if (url.username || url.password) throw new Error("Gotenberg baseUrl cannot include credentials");
    if (url.search || url.hash) throw new Error("Gotenberg baseUrl cannot include a query or fragment");
    if (!Number.isSafeInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 1) {
      throw new Error("timeoutMs must be a positive safe integer");
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxHtmlBytes = options.maxHtmlBytes ?? 5_000_000;
    this.maxPdfBytes = options.maxPdfBytes ?? 25_000_000;
    if (!Number.isSafeInteger(this.maxHtmlBytes) || this.maxHtmlBytes < 1 ||
        this.maxHtmlBytes > MAX_HTML_BYTES) {
      throw new Error(`maxHtmlBytes must be between 1 and ${MAX_HTML_BYTES}`);
    }
    if (!Number.isSafeInteger(this.maxPdfBytes) || this.maxPdfBytes < 1 ||
        this.maxPdfBytes > MAX_PDF_BYTES) {
      throw new Error(`maxPdfBytes must be between 1 and ${MAX_PDF_BYTES}`);
    }
    this.fetcher = options.fetcher ?? fetch;
  }

  async renderHtml(html: string, options: PdfRenderOptions = {}): Promise<Uint8Array> {
    if (!html.trim()) throw new Error("html is required");
    if (new TextEncoder().encode(html).byteLength > this.maxHtmlBytes) {
      throw new Error(`html exceeds the ${this.maxHtmlBytes}-byte limit`);
    }

    const form = new FormData();
    form.append("files", new Blob([html], { type: "text/html" }), "index.html");
    const unknownKeys = Object.keys(options).filter(
      (key) => !PDF_OPTION_KEYS.includes(key as (typeof PDF_OPTION_KEYS)[number]),
    );
    if (unknownKeys.length) throw new Error(`unknown PDF option: ${unknownKeys[0]}`);
    for (const key of PDF_OPTION_KEYS) {
      const value = options[key];
      if (value !== undefined) {
        const length = /^(\d+(?:\.\d+)?)(in|cm|mm|px|pt)$/.exec(value);
        // Gotenberg passes these values to Chromium; bounds prevent pathological page sizes.
        const limits: Readonly<Record<string, number>> = { in: 200, cm: 500, mm: 5_000, px: 20_000, pt: 15_000 };
        const numericValue = length ? Number(length[1]) : Number.NaN;
        const isPaperSize = key === "paperWidth" || key === "paperHeight";
        if (
          !length ||
          value.length > 20 ||
          numericValue > limits[length[2]] ||
          (isPaperSize && numericValue === 0)
        ) {
          throw new Error(`${key} must be a bounded ${isPaperSize ? "positive" : "non-negative"} CSS length`);
        }
        form.append(key, value);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await runWithAbort(
        () => this.fetcher(`${this.baseUrl}/forms/chromium/convert/html`, {
          method: "POST",
          body: form,
          signal: controller.signal,
        }),
        controller.signal,
        "Gotenberg request"
      );
      if (!response.ok) {
        const detail = await readBoundedText(response, 500, controller.signal).catch(() => "");
        throw new Error(`Gotenberg render failed (${response.status}): ${detail}`);
      }
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/pdf")) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Gotenberg returned a non-PDF response");
      }
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > this.maxPdfBytes) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`PDF exceeds the ${this.maxPdfBytes}-byte limit`);
      }
      if (!response.body) throw new Error("Gotenberg returned an empty PDF");

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await runWithAbort(
          () => reader.read(),
          controller.signal,
          "Gotenberg PDF response"
        );
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > this.maxPdfBytes) {
          void reader.cancel().catch(() => {});
          throw new Error(`PDF exceeds the ${this.maxPdfBytes}-byte limit`);
        }
        chunks.push(value);
      }
      if (totalBytes === 0) throw new Error("Gotenberg returned an empty PDF");
      const pdf = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        pdf.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (pdf.byteLength < 5 || new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-") {
        throw new Error("Gotenberg returned malformed PDF content");
      }
      return pdf;
    } finally {
      clearTimeout(timeout);
    }
  }
}
