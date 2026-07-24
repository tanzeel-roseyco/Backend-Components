/**
 * Multi-Provider LLM Abstraction
 * ================================
 * Unified, OpenAI-SDK-compatible LLM client factory with a priority fallback
 * chain across multiple providers (Groq, Gemini, OpenAI) plus support for
 * custom base URLs. All three providers are consumed through the OpenAI SDK by
 * pointing `baseURL` at each provider's OpenAI-compatible endpoint, so callers
 * get one client shape regardless of which provider ends up serving requests.
 *
 * Resolution order (highest priority first):
 *   1. GROQ_API_KEY   (env)  -> Groq OpenAI-compatible endpoint
 *   2. GEMINI_API_KEY (env)  -> Gemini OpenAI-compatible endpoint
 *   3. User-configured key   -> from a pluggable preferences store (Gemini or OpenAI)
 *
 * Required / optional environment variables:
 *   - GROQ_API_KEY   (optional) Admin-configured Groq key; takes top priority.
 *   - GEMINI_API_KEY (optional) Admin-configured Gemini key; second priority.
 *   (No key value is ever embedded in source — keys are read only from env or
 *    the injected preferences store.)
 *
 * Key dependencies:
 *   - `openai` (npm) — the OpenAI Node SDK, used as a generic OpenAI-compatible
 *     transport for all three providers.
 *   - A preferences store (see `PreferencesStore`) for per-user fallback keys.
 *
 * AIDEV-NOTE: Adapted and generalized from a production codebase.
 * Role: single source of truth for "which LLM client + model do we use for
 * this user right now". SECURITY: never log the resolved API key; the returned
 * client embeds the secret. ORDERING is load-bearing — admin env keys are
 * intentionally checked BEFORE per-user keys so a known-good server key always
 * wins over a possibly-stale user key. Do not reorder without understanding
 * that operational contract.
 */

import OpenAI from "openai";

// AIDEV-NOTE: Original source imported a Prisma client singleton:
//   import { prisma } from "@/lib/prisma";
// That internal dependency is replaced here by the injectable `PreferencesStore`
// port below so this module is self-contained and framework-agnostic.

/** Supported user-selectable providers for the per-user fallback path. */
export type AiProvider = "gemini" | "openai";

/**
 * Per-user AI preferences, as read from persistence. All fields are optional
 * because a user may have configured none, some, or all of them.
 */
export interface UserPreferences {
  /** User-supplied API key for their chosen provider. */
  openaiApiKey?: string | null;
  /** Which provider the user's key targets. Defaults to "gemini" when absent. */
  aiProvider?: AiProvider | null;
  /** Explicit model override; falls back to a provider default when absent. */
  openaiModel?: string | null;
}

/**
 * Port for reading per-user preferences. Implement this against whatever
 * persistence layer the host app uses (e.g. Prisma, Drizzle, an HTTP service).
 *
 * AIDEV-NOTE: Injecting this port keeps domain logic free of ORM/vendor types.
 */
export interface PreferencesStore {
  /** Returns the user's preferences, or null/undefined if none are stored. */
  getByUserId(userId: string): Promise<UserPreferences | null | undefined>;
}

/** Options controlling provider endpoints and default models. */
export interface LlmClientOptions {
  /**
   * Base URL for Gemini's OpenAI-compatible endpoint.
   * Override to point at a proxy or a pinned API version.
   */
  geminiBaseUrl?: string;
  /**
   * Base URL for Groq's OpenAI-compatible endpoint.
   * Override to point at a proxy or a pinned API version.
   */
  groqBaseUrl?: string;
  /** Model used when the Groq env key wins. */
  groqModel?: string;
  /** Model used when the Gemini env key wins. */
  geminiEnvModel?: string;
  /** Default model for a user-configured Gemini key (when no explicit model set). */
  geminiUserDefaultModel?: string;
  /** Default model for a user-configured OpenAI key (when no explicit model set). */
  openaiUserDefaultModel?: string;
}

/** Resolved client plus the model id the caller should request against it. */
export interface ResolvedLlmClient {
  client: OpenAI;
  model: string;
}

// Default OpenAI-compatible endpoints for each non-OpenAI provider.
const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";
const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";

// Sensible default models per provider. Callers may override via options.
const DEFAULTS: Required<LlmClientOptions> = {
  geminiBaseUrl: DEFAULT_GEMINI_BASE_URL,
  groqBaseUrl: DEFAULT_GROQ_BASE_URL,
  groqModel: "llama-3.3-70b-versatile",
  geminiEnvModel: "gemini-2.0-flash",
  geminiUserDefaultModel: "gemini-2.0-flash",
  openaiUserDefaultModel: "gpt-4o-mini",
};

/**
 * Resolve an OpenAI-SDK-compatible LLM client and model for a given user,
 * following the admin-env-first priority fallback chain.
 *
 * Resolution:
 *   1. `GROQ_API_KEY`   env set  -> Groq client (admin choice, top priority).
 *   2. `GEMINI_API_KEY` env set  -> Gemini client.
 *   3. Otherwise, the user's stored key from `store` (Gemini or OpenAI).
 *
 * @param userId - Identifier used to look up per-user fallback preferences.
 * @param store  - Preferences port; only consulted if no admin env key is set.
 * @param options - Optional overrides for base URLs and default models.
 * @returns The resolved client and the model id to use with it.
 * @throws {Error} If no admin env key is set and the user has no configured key.
 */
export async function getLlmClient(
  userId: string,
  store: PreferencesStore,
  options: LlmClientOptions = {},
): Promise<ResolvedLlmClient> {
  const cfg = { ...DEFAULTS, ...options };

  // Validate boundary inputs: userId is required to look up per-user fallback
  // keys, and store must be present to reach that path. Fail loud rather than
  // letting an empty id silently query the store or a missing store throw a
  // cryptic TypeError deep in the fallback branch.
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("getLlmClient: `userId` must be a non-empty string.");
  }
  if (!store || typeof store.getByUserId !== "function") {
    throw new Error("getLlmClient: a valid `PreferencesStore` is required.");
  }

  // Server env keys take priority (admin-configured, known-working).
  // Trim to reject whitespace-only values that would otherwise pass the
  // truthiness check below and produce a client with an unusable key.
  const groqKey = (process.env.GROQ_API_KEY || "").trim();
  const geminiEnvKey = (process.env.GEMINI_API_KEY || "").trim();

  // If GROQ_API_KEY is set, always use it — it's the admin's explicit choice
  // and should win over any per-user key, even a valid one.
  if (groqKey) {
    return {
      client: new OpenAI({ apiKey: groqKey, baseURL: cfg.groqBaseUrl }),
      model: cfg.groqModel,
    };
  }

  // Second priority: admin-configured Gemini key.
  if (geminiEnvKey) {
    return {
      client: new OpenAI({ apiKey: geminiEnvKey, baseURL: cfg.geminiBaseUrl }),
      model: cfg.geminiEnvModel,
    };
  }

  // Fall back to the user-configured key from preferences.
  const preferences = await store.getByUserId(userId);

  const userKey = (preferences?.openaiApiKey || "").trim();
  if (!userKey) {
    // Fail loud: without any key we cannot construct a usable client.
    throw new Error(
      "AI API key not configured. Set GROQ_API_KEY in the environment " +
        "(e.g. .env.local), or configure a per-user key in preferences.",
    );
  }

  // Default provider is Gemini when the user hasn't specified one. The stored
  // value is untrusted (it comes from the persistence layer), so normalize any
  // unrecognized value to the "gemini" default rather than silently falling
  // through to the OpenAI branch on a typo'd/legacy provider string.
  const provider: AiProvider =
    preferences?.aiProvider === "openai" ? "openai" : "gemini";
  const defaultModel =
    provider === "gemini" ? cfg.geminiUserDefaultModel : cfg.openaiUserDefaultModel;
  const model = preferences?.openaiModel || defaultModel;

  if (provider === "gemini") {
    return {
      client: new OpenAI({ apiKey: userKey, baseURL: cfg.geminiBaseUrl }),
      model,
    };
  }

  // OpenAI: use the SDK's default base URL (no override needed).
  return {
    client: new OpenAI({ apiKey: userKey }),
    model,
  };
}
