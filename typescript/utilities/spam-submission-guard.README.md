# Spam submission guard

This component applies a few deterministic checks to lead or contact-form submissions. It normalises email addresses, creates a Gmail-aware canonical key, detects dotted Gmail aliases, and flags names that look like repeated-character or consonant-heavy gibberish.

`assessSubmission` accepts an email address and name and returns a `SpamAssessment` containing a boolean rejection decision and a list of reasons. It performs no I/O and has no configuration or external dependencies.

The rules are heuristics, not proof that a person is malicious. In particular, unusual real names can match the name checks, while sophisticated spam can pass them. A consuming application should decide whether to block, review, or merely score a flagged submission.

The adjacent Node test covers Gmail canonicalisation and one obvious gibberish-name case.
