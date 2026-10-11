/*
 * FMI OS calendar sign-in callback relay (Task 7.1).
 *
 * Google / Microsoft redirect the sign-in pop-up here (the registered OAuth
 * redirect URI). This script:
 *   1. removes the authorization response (access token or code) from the
 *      address bar and session history straight away;
 *   2. hands the response to the FMI OS window that started sign-in, over a
 *      same-origin BroadcastChannel — which still works when the provider's
 *      Cross-Origin-Opener-Policy has severed window.opener — and over
 *      window.opener.postMessage (restricted to this origin) when available;
 *   3. closes the pop-up.
 * It never stores anything. Keep CHANNEL_NAME / MESSAGE_TYPE in sync with
 * src/calendar/oauthPopup.ts.
 */
(function () {
  'use strict';

  var CHANNEL_NAME = 'fmios-calendar-oauth';
  var MESSAGE_TYPE = 'fmios-calendar-oauth-callback';
  var message = {
    type: MESSAGE_TYPE,
    search: window.location.search,
    hash: window.location.hash
  };

  try {
    window.history.replaceState(null, '', window.location.pathname);
  } catch (error) {
    // Ignore: the pop-up closes below anyway.
  }

  try {
    if (typeof BroadcastChannel === 'function') {
      new BroadcastChannel(CHANNEL_NAME).postMessage(message);
    }
  } catch (error) {
    // Fall through to window.opener.
  }

  try {
    if (window.opener && window.opener !== window) {
      window.opener.postMessage(message, window.location.origin);
    }
  } catch (error) {
    // Opener gone or cross-origin: BroadcastChannel already delivered it.
  }

  window.setTimeout(function () {
    window.close();
  }, 100);
})();
