# Contact form handler

This TypeScript class validates contact-form data and calls an injected email service for an administrator notification.

## Current behavior

`handle()` validates name, email, optional subject, message, and optional phone with Zod. It then generates a contact ID, logs that it stored the contact, sends an HTML-escaped notification, and returns the ID. Notification failure is logged but does not change a successful result.

## Inputs and configuration

Construct `ContactFormHandler` with a named storage backend, an object exposing `send()`, an administrator email, and optional duplicate settings. Pass an unknown request payload to `handle()`.

## Reusing it

Before production use, replace `storeContact()` with a real database insert and implement `checkDuplicate()` against that store. Pass a functioning email adapter and keep the service configuration outside request data.

## Verified limitations

The storage backend setting is currently unused, no contact is persisted, and duplicate checking always returns `false`. Generated IDs use time plus `Math.random`, not a database or cryptographic identifier. `emailService` and the request argument are typed as `any`. The returned success therefore means validation and the placeholder storage path completed, not that durable storage exists. No dedicated tests accompany this file.
