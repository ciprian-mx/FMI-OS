/**
 * University email domain validation.
 *
 * Task 1.2 (Requirements 1.1): registration is restricted to students holding a
 * university email address. The canonical UNIBUC student domain used by FMI OS
 * is `s.unibuc.ro` (see design.md — Auth Flow). The allow-list below is the
 * single source of truth for both the client-side form check (RegisterPage,
 * task 1.3) and the server-side Cognito pre-sign-up Lambda trigger
 * (`amplify/backend/function/fmiosPreSignup`), so the rule stays identical on
 * both sides of the boundary.
 *
 * The list is intentionally exported and easy to extend: add further faculty or
 * university sub-domains (e.g. a staff domain) by appending to
 * ALLOWED_UNIVERSITY_EMAIL_DOMAINS.
 */

/**
 * Allowed university email domains. Matching is case-insensitive and performed
 * against the host portion to the right of the `@`.
 *
 * A leading-dot entry (e.g. `.unibuc.ro`) additionally permits any sub-domain
 * of that parent (e.g. `fmi.unibuc.ro`). Plain entries match that exact host
 * only.
 */
export const ALLOWED_UNIVERSITY_EMAIL_DOMAINS: readonly string[] = [
  's.unibuc.ro',
];

/** Structured outcome of an email validation check. */
export interface EmailValidationResult {
  valid: boolean;
  /** Present only when `valid` is false; a human-readable reason. */
  error?: string;
}

/**
 * Human-readable summary of the accepted domains, suitable for surfacing in UI
 * error messages and tooltips.
 */
export function allowedDomainsMessage(
  domains: readonly string[] = ALLOWED_UNIVERSITY_EMAIL_DOMAINS
): string {
  const normalized = domains.map((d) => `@${stripLeadingDot(d)}`);
  if (normalized.length === 1) {
    return `Registration is restricted to ${normalized[0]} email addresses.`;
  }
  return `Registration is restricted to the following email domains: ${normalized.join(
    ', '
  )}.`;
}

/**
 * Extracts the lower-cased domain (host) portion of an email address, or `null`
 * when the input is not a syntactically plausible single email address.
 *
 * This is deliberately strict but simple: exactly one `@`, a non-empty local
 * part, and a domain containing at least one dot with non-empty labels. It is
 * not a full RFC 5322 parser — it only needs to be good enough to reliably pull
 * out the host for domain comparison and to reject obvious garbage.
 */
export function extractEmailDomain(email: string): string | null {
  if (typeof email !== 'string') {
    return null;
  }

  const trimmed = email.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Exactly one "@".
  const atIndex = trimmed.indexOf('@');
  if (atIndex === -1 || atIndex !== trimmed.lastIndexOf('@')) {
    return null;
  }

  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1).toLowerCase();

  if (local.length === 0 || domain.length === 0) {
    return null;
  }

  // No whitespace permitted anywhere.
  if (/\s/.test(trimmed)) {
    return null;
  }

  // Domain must have at least two non-empty, dot-separated labels and contain
  // only characters valid in a hostname.
  const labels = domain.split('.');
  if (labels.length < 2) {
    return null;
  }
  if (labels.some((label) => label.length === 0)) {
    return null;
  }
  if (!/^[a-z0-9.-]+$/.test(domain)) {
    return null;
  }

  return domain;
}

/**
 * Returns true when `domain` is permitted by `allowed`.
 *
 * A plain allow-list entry matches that host exactly. An entry written with a
 * leading dot (`.unibuc.ro`) matches that parent host and any sub-domain of it.
 */
export function isAllowedDomain(
  domain: string,
  allowed: readonly string[] = ALLOWED_UNIVERSITY_EMAIL_DOMAINS
): boolean {
  const host = domain.toLowerCase();
  return allowed.some((entry) => {
    const normalizedEntry = entry.toLowerCase();
    if (normalizedEntry.startsWith('.')) {
      const parent = normalizedEntry.slice(1);
      return host === parent || host.endsWith(`.${parent}`);
    }
    return host === normalizedEntry;
  });
}

/**
 * Validates that `email` is a syntactically plausible address whose domain is
 * in the university allow-list.
 *
 * This is the shared gate used by the registration form (client side) and the
 * Cognito pre-sign-up Lambda (server side), guaranteeing both apply the same
 * rule. Returns a structured result rather than throwing so callers can render
 * the `error` string directly.
 */
export function validateUniversityEmail(
  email: string,
  allowed: readonly string[] = ALLOWED_UNIVERSITY_EMAIL_DOMAINS
): EmailValidationResult {
  const domain = extractEmailDomain(email);
  if (domain === null) {
    return { valid: false, error: 'Enter a valid email address.' };
  }

  if (!isAllowedDomain(domain, allowed)) {
    return { valid: false, error: allowedDomainsMessage(allowed) };
  }

  return { valid: true };
}

function stripLeadingDot(domain: string): string {
  return domain.startsWith('.') ? domain.slice(1) : domain;
}
