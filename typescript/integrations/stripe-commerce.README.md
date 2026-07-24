# Stripe commerce workflow

This module standardizes two Stripe server-side operations: idempotent Checkout session creation through an injected provider, and signed webhook processing into a monotonic payment and refund state.

## Using it

Implement `StripeCheckoutStore`, `StripeCheckoutProvider`, and `StripePaymentTransitionStore`. Pass tenant, merchant, order, currency, line items, URLs, and a stable idempotency key to `createStripeCheckout`. Pass exact webhook bytes, the Stripe signature header, active secrets, and a transition store to `processStripeWebhook`.

Amounts are integer minor units. Inputs and totals are bounded, checkout URLs must use Stripe's approved origin, signatures are time-checked, and stored payment evidence cannot move backward or change provider lineage.

## Tests

`stripe-commerce.test.js` covers checkout replay and conflict, validation, deadlines, signature rotation, duplicate and out-of-order events, refunds, store corruption, and cancellation.

## Limits

The module does not instantiate the Stripe SDK, create products, calculate tax, or implement a database. Supported webhook event types are limited to the payment transitions recognized in the source.
