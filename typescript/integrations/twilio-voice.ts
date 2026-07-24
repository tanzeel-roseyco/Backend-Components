import { createHmac, timingSafeEqual } from "node:crypto";

export interface PublicUrlInput {
  readonly requestUrl: string;
  readonly publicBaseUrl: string;
}

function validateHttpUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${label} must use HTTP or HTTPS`);
  if (url.username || url.password) throw new Error(`${label} cannot contain credentials`);
  return url;
}

/** Reconstructs the externally visible URL used by Twilio when signing a webhook. */
export function reconstructPublicUrl(input: PublicUrlInput): string {
  const base = validateHttpUrl(input.publicBaseUrl, "publicBaseUrl");
  if (base.pathname !== "/" || base.search || base.hash) {
    throw new Error("publicBaseUrl must contain only a trusted origin");
  }
  if (!input.requestUrl.startsWith("/")) throw new Error("requestUrl must be a path and query");
  const request = new URL(input.requestUrl, base);
  if (request.origin !== base.origin || request.username || request.password || request.hash) {
    throw new Error("requestUrl must contain only a path and query");
  }
  return request.toString();
}

export interface VerifyTwilioSignatureInput {
  readonly authToken: string;
  readonly signature: string | undefined;
  readonly url: string;
  readonly params?: Readonly<Record<string, string | readonly string[]>>;
}

/** Implements Twilio's HMAC-SHA1 webhook signing algorithm for form-encoded requests. */
export function verifyTwilioSignature(input: VerifyTwilioSignatureInput): boolean {
  if (!input.authToken.trim()) throw new Error("authToken is required");
  if (!input.signature) return false;
  const url = validateHttpUrl(input.url, "url").toString();
  if (Buffer.byteLength(url) > 2_048) throw new Error("url cannot exceed 2048 bytes");
  const keys = Object.keys(input.params ?? {}).sort();
  if (keys.length > 100) throw new Error("params cannot exceed 100 keys");
  const hmac = createHmac("sha1", input.authToken).update(url, "utf8");
  for (const key of keys) {
    if (!key || Buffer.byteLength(key) > 100) throw new Error("parameter keys must contain 1-100 bytes");
    const raw = input.params?.[key];
    const values = Array.isArray(raw) ? [...raw].sort() : [raw];
    if (values.length > 20) throw new Error(`params.${key} cannot exceed 20 values`);
    for (const value of values) {
      if (typeof value !== "string") throw new Error(`params.${key} must contain only strings`);
      if (Buffer.byteLength(value) > 4_000) throw new Error(`params.${key} values cannot exceed 4000 bytes`);
      hmac.update(key, "utf8").update(value, "utf8");
    }
  }
  const expected = hmac.digest();
  if (!/^[A-Za-z0-9+/]{27}=$/.test(input.signature)) return false;
  const supplied = Buffer.from(input.signature, "base64");
  if (supplied.toString("base64") !== input.signature) return false;
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character] ?? character);
}

export interface ConferenceJoinOptions {
  readonly conferenceName: string;
  readonly muted?: boolean;
  readonly startConferenceOnEnter?: boolean;
  readonly endConferenceOnExit?: boolean;
}

export function buildConferenceJoinTwiml(options: ConferenceJoinOptions): string {
  if (!options.conferenceName.trim()) throw new Error("conferenceName is required");
  if (options.conferenceName.length > 128) throw new Error("conferenceName cannot exceed 128 characters");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(options.conferenceName)) {
    throw new Error("conferenceName contains characters forbidden by XML 1.0");
  }
  const attributes = [
    `muted="${options.muted ?? false}"`,
    `startConferenceOnEnter="${options.startConferenceOnEnter ?? true}"`,
    `endConferenceOnExit="${options.endConferenceOnExit ?? false}"`,
  ].join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference ${attributes}>${xml(options.conferenceName)}</Conference></Dial></Response>`;
}

export type TwoLegConferenceState =
  | "pending"
  | "first_leg_dialing"
  | "second_leg_dialing"
  | "connected"
  | "failed";

export interface TwoLegConference {
  readonly id: string;
  readonly conferenceName: string;
  readonly firstNumber: string;
  readonly secondNumber: string;
  readonly state: TwoLegConferenceState;
  readonly firstCallSid?: string;
  readonly secondCallSid?: string;
  readonly failureReason?: string;
}

export type ConferenceEvent =
  | { readonly type: "start" }
  | { readonly type: "first_answered"; readonly callSid: string }
  | { readonly type: "second_answered"; readonly callSid: string }
  | {
      readonly type: "leg_failed";
      readonly leg: "first" | "second";
      readonly callSid: string;
      readonly reason: string;
    };

export interface CallRequest {
  readonly to: string;
  readonly conferenceName: string;
  readonly leg: "first" | "second";
  readonly idempotencyKey: string;
}

export interface TwilioVoiceDependencies {
  /** Repeated calls with the same idempotencyKey must return the same provider call. */
  readonly createCall: (request: CallRequest) => Promise<{ readonly callSid: string }>;
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return value;
}

function validateConferenceSnapshot(conference: TwoLegConference): void {
  const hasFirst = Boolean(conference.firstCallSid?.trim());
  const hasSecond = Boolean(conference.secondCallSid?.trim());
  const hasFailureReason = Boolean(conference.failureReason?.trim());
  if (
    (conference.state === "pending" && (hasFirst || hasSecond)) ||
    (conference.state === "first_leg_dialing" && (!hasFirst || hasSecond)) ||
    ((conference.state === "second_leg_dialing" || conference.state === "connected") && (!hasFirst || !hasSecond)) ||
    (conference.state === "failed" && (!hasFirst || !hasFailureReason)) ||
    (conference.state !== "failed" && hasFailureReason)
  ) {
    throw new Error(`conference snapshot is invalid for ${conference.state}`);
  }
}

/** Applies one valid forward-only event and performs only the call creation required by it. */
export async function handleTwoLegConferenceEvent(
  conference: TwoLegConference,
  event: ConferenceEvent,
  dependencies: TwilioVoiceDependencies,
): Promise<TwoLegConference> {
  required(conference.id, "id");
  required(conference.conferenceName, "conferenceName");
  required(conference.firstNumber, "firstNumber");
  required(conference.secondNumber, "secondNumber");
  validateConferenceSnapshot(conference);

  if (event.type === "leg_failed") {
    if (conference.state === "connected" || conference.state === "failed") {
      throw new Error(`leg_failed is invalid from ${conference.state}`);
    }
    const expectedLeg = conference.state === "first_leg_dialing" ? "first" : "second";
    const expectedSid = expectedLeg === "first" ? conference.firstCallSid : conference.secondCallSid;
    if (event.leg !== expectedLeg || required(event.callSid, "callSid") !== expectedSid) {
      throw new Error("failed leg does not match the active call");
    }
    return { ...conference, state: "failed", failureReason: required(event.reason, "reason") };
  }
  if (conference.state === "pending" && event.type === "start") {
    const call = await dependencies.createCall({
      to: conference.firstNumber,
      conferenceName: conference.conferenceName,
      leg: "first",
      idempotencyKey: `${conference.id}:first`,
    });
    return { ...conference, state: "first_leg_dialing", firstCallSid: required(call.callSid, "callSid") };
  }
  if (conference.state === "first_leg_dialing" && event.type === "first_answered") {
    if (conference.firstCallSid !== required(event.callSid, "callSid")) throw new Error("first callSid does not match");
    const call = await dependencies.createCall({
      to: conference.secondNumber,
      conferenceName: conference.conferenceName,
      leg: "second",
      idempotencyKey: `${conference.id}:second`,
    });
    return { ...conference, state: "second_leg_dialing", secondCallSid: required(call.callSid, "callSid") };
  }
  if (conference.state === "second_leg_dialing" && event.type === "second_answered") {
    if (conference.secondCallSid !== required(event.callSid, "callSid")) throw new Error("second callSid does not match");
    return { ...conference, state: "connected" };
  }
  throw new Error(`${event.type} is invalid from ${conference.state}`);
}
