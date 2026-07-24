# Email handler

This file defines a common result shape and adapters named for Resend, SendGrid, and SMTP, with an optional fallback service.

## Current behavior

Each adapter validates the recipient address, writes a message to the console, and returns a generated message ID. It does **not** call an email provider. The commented examples show possible SDK wiring but are not executable integration code. `MultiServiceEmailHandler` calls the fallback only when the primary returns `success: false`.

## Inputs and outputs

`EmailPayload` carries one recipient, subject, HTML, and optional text, sender, copies, and reply-to fields. `send()` returns `{ success, messageId?, error?, service }`. The constructors reject missing API keys, while the SMTP constructor expects an object containing `host` and `port`.

## Reusing it

Implement the provider call inside the relevant adapter or subclass `EmailHandler`, then pass primary and fallback instances to `MultiServiceEmailHandler`. Keep credentials in runtime configuration.

## Verified limitations

This is a scaffold, not a working delivery integration. `formsubmit` appears in the configuration types but the factory does not implement it. SMTP configuration and fallback configuration are untyped, only the primary recipient is validated, and no dedicated tests accompany this file.
