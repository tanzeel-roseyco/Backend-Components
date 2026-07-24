const assert = require("node:assert/strict");
const test = require("node:test");
const redaction = require("../.test-dist/utilities/secret-redaction.js");

test("redacts token-shaped values", () => {
  assert.equal(redaction.redactSecrets("token=sk-test_12345678901234567890"), "token=[REDACTED]");
});

test("redacts named values without removing diagnostic keys", () => {
  assert.equal(redaction.redactSecrets("authorization: Bearer abcdefghijklmnopqrst"), "authorization=[REDACTED]");
  assert.equal(redaction.redactSecrets('{"token":"abcdefghijklmnop"}'), '{"token=[REDACTED]}');
  assert.equal(redaction.redactSecrets('password="my secret phrase"'), "password=[REDACTED]");
  assert.equal(
    redaction.redactSecrets('{"password":"my \\"secret\\" phrase"}'),
    '{"password=[REDACTED]}',
  );
  assert.equal(redaction.redactSecrets("API key: abcdefghijklmnop"), "API key=[REDACTED]");
});

test("redacts explicit short secrets", () => {
  assert.equal(redaction.redactSecrets("password=shh", ["shh"]), "password=[REDACTED]");
  assert.equal(redaction.redactSecrets("abcdef", ["abc", "abcdef"]), "[REDACTED]");
});
