# Python login rate limiter

This asynchronous component tracks failed authentication attempts by IP address. `check_limit` reports whether another attempt is allowed, `record_failure` advances the counter and lockout, and successful authentication or an explicit reset removes the record.

The constructor controls maximum attempts, lockout minutes, reset hours, and the storage backend. An in-memory implementation is supplied; production deployments can implement the three asynchronous storage methods. A middleware factory and best-effort request-IP extractor are included.

In-memory records are process-local, disappear on restart, and are not safe for coordination across multiple workers. Proxy-derived addresses are trustworthy only when forwarding headers are controlled by the deployment. Raw IP addresses are used in storage keys, so a durable adapter should consider privacy and retention requirements.

There is no dedicated test file in this repository.
