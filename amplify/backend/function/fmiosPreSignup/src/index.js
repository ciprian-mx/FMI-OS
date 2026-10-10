'use strict';

const { validateUniversityEmail } = require('./universityEmail');

/**
 * Cognito Pre Sign-up Lambda trigger for FMI OS.
 *
 * Cognito invokes this synchronously during sign-up (both self sign-up and
 * admin create). The handler validates the submitted email against the
 * university allow-list and REJECTS the sign-up by throwing when the domain is
 * not permitted. The thrown message is surfaced to the client, so it doubles as
 * the user-facing explanation.
 *
 * This is the authoritative server-side enforcement of Requirement 1.1: even if
 * the client-side form check is bypassed, Cognito will not create the user
 * unless the email domain is allowed.
 *
 * It intentionally does NOT auto-confirm the user or auto-verify attributes;
 * normal email verification still applies.
 *
 * @param {Object} event Cognito PreSignUp trigger event.
 * @returns {Promise<Object>} The (unmodified) event on success.
 */
exports.handler = async (event) => {
  const email =
    event &&
    event.request &&
    event.request.userAttributes &&
    event.request.userAttributes.email;

  const result = validateUniversityEmail(email);

  if (!result.valid) {
    // Throwing fails the sign-up; Cognito returns the message to the caller.
    throw new Error(result.error || 'Email address is not permitted.');
  }

  // Approve the sign-up unchanged.
  return event;
};
