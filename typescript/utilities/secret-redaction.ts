/**
 * Secret redaction for logs and diagnostics.
 * Note: Redaction is deliberately broad because logs cross trust boundaries; callers may supply explicit values for short secrets.
 */
const PREFIXED_TOKEN_PATTERN = /\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_.-]{8,}/gi;
const NAMED_SECRET_PATTERN = /\b(api[\s_-]?key|token|secret|authorization|password)\s*["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer\s+)?[^\s,;}]+)/gi;

export function redactSecrets(value: string, explicitSecrets: readonly string[] = []): string {
  let result = value;
  for (const secret of [...new Set(explicitSecrets)].sort((left, right) => right.length - left.length)) {
    if (secret.length > 0) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result
    .replace(NAMED_SECRET_PATTERN, "$1=[REDACTED]")
    .replace(PREFIXED_TOKEN_PATTERN, "[REDACTED]");
}
