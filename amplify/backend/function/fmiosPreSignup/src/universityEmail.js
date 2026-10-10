'use strict';

/**
 * University email domain allow-list for the Cognito pre-sign-up trigger.
 *
 * This is the server-side mirror of `src/auth/universityEmail.ts`. The two must
 * stay in sync: the client form (RegisterPage) gives fast feedback, while this
 * Lambda is the authoritative gate Cognito enforces on every sign-up, including
 * ones that bypass the UI (e.g. direct API/CLI calls).
 *
 * Written in plain CommonJS JavaScript so it runs on the Lambda Node.js runtime
 * with no build step.
 */

/**
 * Allowed university email domains. A leading-dot entry (e.g. `.unibuc.ro`)
 * additionally permits any sub-domain of that parent; plain entries match the
 * exact host only.
 *
 * @type {ReadonlyArray<string>}
 */
const ALLOWED_UNIVERSITY_EMAIL_DOMAINS = ['s.unibuc.ro'];

/**
 * Extract the lower-cased domain of an email address, or null if the address is
 * not a syntactically plausible single email.
 *
 * @param {unknown} email
 * @returns {string | null}
 */
function extractEmailDomain(email) {
  if (typeof email !== 'string') {
    return null;
  }

  const trimmed = email.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const atIndex = trimmed.indexOf('@');
  if (atIndex === -1 || atIndex !== trimmed.lastIndexOf('@')) {
    return null;
  }

  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1).toLowerCase();

  if (local.length === 0 || domain.length === 0) {
    return null;
  }

  if (/\s/.test(trimmed)) {
    return null;
  }

  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0)) {
    return null;
  }
  if (!/^[a-z0-9.-]+$/.test(domain)) {
    return null;
  }

  return domain;
}

/**
 * @param {string} domain
 * @param {ReadonlyArray<string>} [allowed]
 * @returns {boolean}
 */
function isAllowedDomain(domain, allowed) {
  const list = allowed || ALLOWED_UNIVERSITY_EMAIL_DOMAINS;
  const host = String(domain).toLowerCase();
  return list.some((entry) => {
    const normalizedEntry = entry.toLowerCase();
    if (normalizedEntry.startsWith('.')) {
      const parent = normalizedEntry.slice(1);
      return host === parent || host.endsWith('.' + parent);
    }
    return host === normalizedEntry;
  });
}

/**
 * @param {string} email
 * @param {ReadonlyArray<string>} [allowed]
 * @returns {{ valid: boolean, error?: string }}
 */
function validateUniversityEmail(email, allowed) {
  const list = allowed || ALLOWED_UNIVERSITY_EMAIL_DOMAINS;
  const domain = extractEmailDomain(email);
  if (domain === null) {
    return { valid: false, error: 'Enter a valid email address.' };
  }
  if (!isAllowedDomain(domain, list)) {
    const human = list.map((d) => '@' + (d.startsWith('.') ? d.slice(1) : d));
    return {
      valid: false,
      error:
        'Registration is restricted to the following email domains: ' +
        human.join(', ') +
        '.',
    };
  }
  return { valid: true };
}

module.exports = {
  ALLOWED_UNIVERSITY_EMAIL_DOMAINS,
  extractEmailDomain,
  isAllowedDomain,
  validateUniversityEmail,
};
