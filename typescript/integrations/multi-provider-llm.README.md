# Multi-provider LLM client

This module chooses an OpenAI-compatible client and model from a fixed priority chain: a server Groq key, a server Gemini key, or a user preference for Gemini or OpenAI.

## Using it

Set `GROQ_API_KEY` or `GEMINI_API_KEY` for server-wide selection, or implement `PreferencesStore` for per-user provider, key, and model settings. Call the exported resolver to receive the configured OpenAI SDK client and model.

Keys are read from the environment or injected store and are not logged. Provider endpoints are configured through the OpenAI SDK's compatible `baseURL` option.

## Limits

This is selection and client construction, not automatic failover after a provider request fails. It does not validate model availability, enforce budgets, retry calls, or normalize provider-specific response differences.
