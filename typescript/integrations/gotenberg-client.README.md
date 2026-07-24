# Gotenberg HTML-to-PDF client

This adapter sends an HTML document and optional Chromium page settings to Gotenberg and returns the rendered PDF bytes.

## Using it

Construct the client with a Gotenberg base URL and optional fetch, timeout, HTML-size, and PDF-size limits. Call the render method with HTML and supported margin or paper dimensions.

The module bounds input and streamed output, applies a hard request deadline, rejects unsuccessful responses with truncated error details, and cancels oversized response bodies without waiting indefinitely for cancellation.

## Tests

`gotenberg-client.test.js` covers rendering, form fields, invalid configuration, input and output limits, HTTP failures, timeouts, and stalled cancellation.

## Limits

Only the Chromium HTML conversion route and the options declared in `PdfRenderOptions` are wrapped. The caller must operate and secure the Gotenberg service and sanitize untrusted HTML according to its threat model.
