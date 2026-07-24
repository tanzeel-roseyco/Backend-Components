const assert = require("node:assert/strict");
const test = require("node:test");
const guard = require("../.test-dist/utilities/spam-submission-guard.js");

test("canonicalEmailKey collapses Gmail dots, aliases, and tags", () => {
  assert.equal(guard.canonicalEmailKey("A.B+campaign@googlemail.com"), "ab@gmail.com");
  assert.equal(guard.canonicalEmailKey("sales+au@example.com"), "sales+au@example.com");
});

test("assessment catches honeypots and synthetic Gmail addresses", () => {
  assert.equal(guard.assessSubmission({ email: "s.e.q.a@gmail.com" }).isSpam, true);
  assert.deepEqual(guard.assessSubmission({ email: "person@example.com", honeypot: "filled" }).reasons, ["honeypot"]);
});

test("assessment keeps ordinary names and email addresses eligible", () => {
  assert.equal(guard.assessSubmission({ email: "anne.marie@gmail.com", name: "Anne-Marie O'Brien" }).isSpam, false);
  assert.equal(guard.assessSubmission({ email: "person@example.com", name: "Henry VIII" }).isSpam, false);
  assert.equal(guard.assessSubmission({ email: "a.b.smith@gmail.com" }).isSpam, false);
});
