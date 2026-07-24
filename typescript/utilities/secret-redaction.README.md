# Secret redaction

`redactSecrets` removes common credential-shaped values from a string. It recognises several prefixed token formats, values assigned to names such as `api_key`, `token`, `secret`, `authorization`, and `password`, and exact secret strings supplied by the caller.

It returns a new string and performs no I/O. Empty explicit secrets are ignored. Longer explicit values are replaced first so overlapping secrets are handled predictably.

Pattern-based redaction is a last line of defence, not a guarantee that every credential format is covered. Do not log secrets deliberately or treat this function as a substitute for structured safe logging.

The adjacent Node tests cover named secrets, prefixed tokens, explicit values, and empty explicit-secret entries.
