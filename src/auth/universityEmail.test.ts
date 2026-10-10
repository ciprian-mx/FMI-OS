import fc from 'fast-check';
import {
  ALLOWED_UNIVERSITY_EMAIL_DOMAINS,
  allowedDomainsMessage,
  extractEmailDomain,
  isAllowedDomain,
  validateUniversityEmail,
} from './universityEmail';

/**
 * Task 1.2 — university email domain validation.
 *
 * The shared validation gate is exercised here as plain unit tests (specific
 * accepted/rejected examples and edge cases) plus a property-based test over
 * randomly generated local parts, confirming the allow-list rule holds for any
 * local part when the domain is / is not permitted.
 *
 * Validates: Requirements 1.1
 */
describe('extractEmailDomain', () => {
  it('returns the lower-cased host for a valid address', () => {
    expect(extractEmailDomain('Student@S.UNIBUC.RO')).toBe('s.unibuc.ro');
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(extractEmailDomain('  ana@s.unibuc.ro  ')).toBe('s.unibuc.ro');
  });

  it.each([
    ['empty string', ''],
    ['no @', 'anas.unibuc.ro'],
    ['two @', 'a@b@s.unibuc.ro'],
    ['empty local part', '@s.unibuc.ro'],
    ['empty domain', 'ana@'],
    ['domain without dot', 'ana@localhost'],
    ['leading dot label empty', 'ana@.unibuc.ro'],
    ['trailing dot label empty', 'ana@unibuc.ro.'],
    ['internal whitespace', 'an a@s.unibuc.ro'],
    ['illegal domain char', 'ana@s_unibuc.ro'],
  ])('returns null for %s', (_label, input) => {
    expect(extractEmailDomain(input)).toBeNull();
  });
});

describe('isAllowedDomain', () => {
  it('accepts the exact configured domain (case-insensitive)', () => {
    expect(isAllowedDomain('s.unibuc.ro')).toBe(true);
    expect(isAllowedDomain('S.UNIBUC.RO')).toBe(true);
  });

  it('rejects a different domain', () => {
    expect(isAllowedDomain('gmail.com')).toBe(false);
    expect(isAllowedDomain('unibuc.ro')).toBe(false);
  });

  it('rejects a look-alike suffix that is not a real sub-domain', () => {
    // "evils.unibuc.ro" is NOT a sub-domain of the exact entry "s.unibuc.ro".
    expect(isAllowedDomain('evils.unibuc.ro')).toBe(false);
    // Suffix spoof: domain merely ending with the entry text.
    expect(isAllowedDomain('xs.unibuc.ro')).toBe(false);
  });

  it('honours a leading-dot allow-list entry as a sub-domain wildcard', () => {
    const allowed = ['.unibuc.ro'];
    expect(isAllowedDomain('unibuc.ro', allowed)).toBe(true);
    expect(isAllowedDomain('fmi.unibuc.ro', allowed)).toBe(true);
    expect(isAllowedDomain('s.unibuc.ro', allowed)).toBe(true);
    expect(isAllowedDomain('notunibuc.ro', allowed)).toBe(false);
  });
});

describe('validateUniversityEmail', () => {
  it('accepts a well-formed university address', () => {
    expect(validateUniversityEmail('ana.popescu@s.unibuc.ro')).toEqual({
      valid: true,
    });
  });

  it('rejects a non-university domain with the allow-list message', () => {
    const result = validateUniversityEmail('ana@gmail.com');
    expect(result.valid).toBe(false);
    expect(result.error).toBe(allowedDomainsMessage());
  });

  it('rejects a malformed address with a generic message', () => {
    const result = validateUniversityEmail('not-an-email');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Enter a valid email address.');
  });
});

describe('allowedDomainsMessage', () => {
  it('renders a single domain', () => {
    expect(allowedDomainsMessage(['s.unibuc.ro'])).toContain('@s.unibuc.ro');
  });

  it('renders multiple domains', () => {
    const msg = allowedDomainsMessage(['s.unibuc.ro', 'fmi.unibuc.ro']);
    expect(msg).toContain('@s.unibuc.ro');
    expect(msg).toContain('@fmi.unibuc.ro');
  });

  it('strips a leading dot from a wildcard entry', () => {
    expect(allowedDomainsMessage(['.unibuc.ro'])).toContain('@unibuc.ro');
  });
});

describe('property: allow-list rule holds for any local part', () => {
  // A conservative local-part generator: non-empty, no "@", no whitespace.
  const localPart = fc
    .stringMatching(/^[A-Za-z0-9._%+-]+$/)
    .filter((s) => s.length > 0 && s.length <= 64);

  it('accepts any valid local part at an allowed domain', () => {
    fc.assert(
      fc.property(localPart, (local) => {
        const email = `${local}@s.unibuc.ro`;
        return validateUniversityEmail(email).valid === true;
      }),
      { numRuns: 100 }
    );
  });

  it('rejects any valid local part at a disallowed domain', () => {
    const disallowedDomain = fc
      .stringMatching(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
      .filter((d) => !isAllowedDomain(d, ALLOWED_UNIVERSITY_EMAIL_DOMAINS));

    fc.assert(
      fc.property(localPart, disallowedDomain, (local, domain) => {
        const email = `${local}@${domain}`;
        return validateUniversityEmail(email).valid === false;
      }),
      { numRuns: 100 }
    );
  });
});
