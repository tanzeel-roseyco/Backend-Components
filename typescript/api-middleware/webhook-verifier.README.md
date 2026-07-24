# Webhook verifier

This module checks HMAC signatures on webhook request bodies. It provides a general verifier plus small Calendly, ConvertKit, and Stripe subclasses.

## How it works

`WebhookVerifier` signs the supplied body with SHA-256 by default, or SHA-1 when configured, and compares the supplied and expected signatures with Node's constant-time comparison. `middleware()` reads a configured signature header, falls back to `x-webhook-signature` or `x-signature`, and returns HTTP 401 when verification fails. The ConvertKit and Stripe helpers sign `timestamp.rawBody`.

## Inputs and outputs

Construct it with a non-empty shared secret and, optionally, an algorithm and header name. `verify()` accepts a string or `Buffer` body and a signature such as `sha256=<hex>`, returning a boolean. `generateSignature()` returns that prefixed format. The middleware expects Express- or Fastify-like request, response, and `next` objects.

## Reusing it

Copy the module into a Node TypeScript service, keep the raw request body available, and instantiate the verifier with a secret held outside source control. Confirm the upstream provider's exact signing format before using a provider subclass.

## Safety and limitations

Malformed signatures return `false`; the reason is not exposed. There is no timestamp-age check or replay store. The Stripe helper does not parse Stripe's usual comma-separated signature header, and the provider-specific formats must be checked against the provider documentation before production use. The middleware uses `any` and has no dedicated test file in this repository.
