# Twilio voice conference helpers

This module reconstructs the public webhook URL, verifies Twilio's form-request signature, builds conference-join TwiML, and drives a two-leg outbound conference state machine.

## Using it

Configure a trusted public origin rather than trusting forwarded headers. Pass the exact request path, submitted form fields, signature, and Twilio auth token to signature verification. Inject call creation and persistence dependencies when handling two-leg conference events.

The state machine validates each transition and call SID before starting the next leg or marking the conference connected or failed. TwiML values are escaped and bounded.

## Tests

`twilio-voice.test.js` covers URL reconstruction, signature validation, TwiML escaping, successful calls, failed legs, and invalid or conflicting state transitions.

## Limits

This file does not expose HTTP routes, parse incoming form bodies, store conferences, or configure Twilio phone numbers. Those boundaries must preserve the exact URL and parameters used for signature verification.
