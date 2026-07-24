/**
 * Pure, conservative checks for public form submissions.
 * Note: These heuristics intentionally favour false negatives; blocking a real lead costs more than spam review.
 */
export interface SpamAssessment {
  readonly emailKey: string;
  readonly reasons: readonly ("honeypot" | "gmail_dot_abuse" | "gibberish_name")[];
  readonly isSpam: boolean;
}

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function canonicalEmailKey(value: string): string {
  const email = normalizeEmail(value);
  const atIndex = email.lastIndexOf("@");
  if (atIndex < 1) return email;

  let local = email.slice(0, atIndex);
  let domain = email.slice(atIndex + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    const plusIndex = local.indexOf("+");
    if (plusIndex >= 0) local = local.slice(0, plusIndex);
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }

  return `${local}@${domain}`;
}

export function looksLikeGmailDotAbuse(value: string): boolean {
  const email = normalizeEmail(value);
  const atIndex = email.lastIndexOf("@");
  if (atIndex < 1 || !GMAIL_DOMAINS.has(email.slice(atIndex + 1))) return false;

  const local = email.slice(0, atIndex);
  const dotCount = (local.match(/\./g) ?? []).length;
  return dotCount >= 3;
}

export function looksLikeGibberishName(value: string): boolean {
  const name = value.trim();
  if (name.length === 0) return false;
  return name.split(/[\s'-]+/).filter(Boolean).some((part) => {
    const letters = part.replace(/[^a-z]/gi, "");
    if (letters.length < 10) return false;
    if (/\d/.test(part)) return true;
    if (/[^aeiouy]{6,}/i.test(letters)) return true;
    const vowelCount = (letters.match(/[aeiouy]/gi) ?? []).length;
    if (vowelCount / letters.length < 0.15) return true;

    if (letters.length < 12) return false;
    let caseFlips = 0;
    for (let index = 1; index < letters.length; index += 1) {
      const previous = letters[index - 1];
      const current = letters[index];
      const previousIsLetter = previous.toLowerCase() !== previous.toUpperCase();
      const currentIsLetter = current.toLowerCase() !== current.toUpperCase();
      if (previousIsLetter && currentIsLetter &&
          ((previous === previous.toLowerCase()) !== (current === current.toLowerCase()))) {
        caseFlips += 1;
      }
    }
    return caseFlips >= 6;
  });
}

export function assessSubmission(input: {
  readonly email: string;
  readonly name?: string;
  readonly honeypot?: string;
}): SpamAssessment {
  const reasons: SpamAssessment["reasons"][number][] = [];
  if (input.honeypot?.trim()) reasons.push("honeypot");
  if (looksLikeGmailDotAbuse(input.email)) reasons.push("gmail_dot_abuse");
  if (input.name && looksLikeGibberishName(input.name)) reasons.push("gibberish_name");
  return { emailKey: canonicalEmailKey(input.email), reasons, isSpam: reasons.length > 0 };
}
