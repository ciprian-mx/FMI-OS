import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  MAX_DISPLAY_NAME_LENGTH,
  validateDisplayName,
  type AuthenticatedStudent,
} from '../account/accountService';
import './AccountCenter.css';

/**
 * Props for {@link AccountCenter}. They follow `AccountCenterProps` in the design
 * doc: the panel is presentational, and every side effect is a callback the
 * owner supplies. `src/account/accountService.ts` (`createAccountService`) backs
 * the profile and API-key callbacks, and `src/account/logout.ts`
 * (`logoutStudent`) backs `onLogout`; wiring them to the Taskbar is task 16.x.
 */
export interface AccountCenterProps {
  /**
   * The signed-in student whose profile and key status the panel shows. Read
   * when the panel opens; later changes are not merged into edits in progress.
   */
  student: AuthenticatedStudent;
  /**
   * Persists the display name (Requirement 6.2). Receives the validated,
   * trimmed value. Reject to keep the draft and show a retryable error. The
   * owner should update `student` once it resolves so a reopened panel starts
   * from the saved name.
   */
  onUpdateProfile: (displayName: string) => Promise<void>;
  /**
   * Generates a new Bedrock API key, invalidating any current one (Requirement
   * 6.3), and resolves with the new raw key. The panel shows that key once and
   * keeps it only in memory while it is open.
   */
  onRegenerateApiKey: () => Promise<string>;
  /** Deletes the student's API key (Requirement 6.3). */
  onDeleteApiKey: () => Promise<void>;
  /**
   * Terminates the session and redirects to the login screen (Requirement
   * 6.4), e.g. `() => logoutStudent()`. A returned promise keeps the button
   * busy; a rejection shows a retryable error.
   */
  onLogout: () => void | Promise<void>;
  /**
   * Asks the owner to close (unmount) the panel (Requirement 6.5). Called once
   * per outside press, per Escape key press, and by the close button.
   */
  onClose: () => void;
}

/** Status shown after the display name is saved. */
export const PROFILE_SAVED_MESSAGE = 'Display name saved.';
/** Shown when `onUpdateProfile` rejects. */
export const PROFILE_SAVE_ERROR_MESSAGE =
  "Couldn't save your display name. Please try again.";
/** Status shown after a key is generated. */
export const API_KEY_GENERATED_MESSAGE = 'New API key generated.';
/** Status shown after the key is deleted. */
export const API_KEY_DELETED_MESSAGE = 'API key deleted.';
/** Shown when `onRegenerateApiKey` rejects (or returns no key). */
export const API_KEY_GENERATE_ERROR_MESSAGE =
  "Couldn't generate a new API key. Please try again.";
/** Shown when `onDeleteApiKey` rejects. */
export const API_KEY_DELETE_ERROR_MESSAGE =
  "Couldn't delete your API key. Please try again.";
/** Shown next to a freshly generated key. */
export const API_KEY_ONE_TIME_WARNING =
  "Copy this key now. For your security, it won't be shown again after you close the Account Center.";
/** Shown when `onLogout` rejects. */
export const LOGOUT_ERROR_MESSAGE = "Couldn't log out. Please try again.";

/** Stand-in for a stored key, whose raw value can never be shown again. */
const MASKED_KEY = '•'.repeat(16);

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

type ProfileStatus = 'idle' | 'saving' | 'saved' | 'error';
type KeyConfirmation = 'regenerate' | 'delete';
type KeyBusy = 'generating' | 'deleting';
type FocusTarget =
  | 'displayName'
  | 'keyValue'
  | 'primaryKeyAction'
  | 'deleteKey'
  | 'confirmKeyAction'
  | 'logout';

/**
 * True when focus no longer sits on a usable control: it fell back to the body,
 * or rests on a control inside the panel that has since been disabled.
 */
function isFocusLost(panel: HTMLElement): boolean {
  const doc = panel.ownerDocument;
  const active = doc.activeElement;
  if (!active || active === doc.body) {
    return true;
  }
  return panel.contains(active) && active.matches(':disabled');
}

/**
 * AccountCenter — the Start Menu–style panel opened from the Taskbar's Account
 * Center button (Requirement 6).
 *
 *   • Profile (6.1, 6.2): the university email, read-only, and an editable
 *     display name validated with `validateDisplayName` before
 *     `onUpdateProfile` runs.
 *   • Bedrock API key (6.3): only a hash is stored, so an existing key is never
 *     viewable again and is shown masked. Generating a key reveals it once (with
 *     a Hide / Show toggle) until the panel closes. Regenerating an existing key
 *     and deleting it are destructive, so each asks for inline confirmation.
 *   • Log out (6.4): calls `onLogout`.
 *   • Closing (6.5): `onClose` fires for a press outside the panel and for the
 *     Escape key, in every panel state (even mid-request or mid-confirmation).
 *     Both triggers are document-level capture listeners, so inner handlers
 *     cannot swallow them. An outside press counts once however it arrives —
 *     pointerdown, mousedown, or a lone click — and presses inside the panel
 *     never close it. The header's close button also calls `onClose`.
 *
 * Accessibility: a modal dialog labelled by its title. Focus moves into the
 * panel on open, Tab / Shift+Tab cycle inside it, and on close focus returns
 * to the previously focused control (the Taskbar button) unless the student has
 * already moved it elsewhere. Async results move focus to the affected control,
 * and statuses / errors are announced through live regions.
 *
 * The owner mounts the panel to open it and unmounts it in response to
 * `onClose`, which also discards any revealed key.
 */
const AccountCenter: React.FC<AccountCenterProps> = ({
  student,
  onUpdateProfile,
  onRegenerateApiKey,
  onDeleteApiKey,
  onLogout,
  onClose,
}) => {
  const baseId = useId();
  const ids = {
    title: `${baseId}-title`,
    profileHeading: `${baseId}-profile`,
    email: `${baseId}-email`,
    emailHint: `${baseId}-email-hint`,
    displayName: `${baseId}-display-name`,
    displayNameError: `${baseId}-display-name-error`,
    keyHeading: `${baseId}-key`,
    keyValue: `${baseId}-key-value`,
    keyWarning: `${baseId}-key-warning`,
    keyConfirm: `${baseId}-key-confirm`,
  };

  const panelRef = useRef<HTMLDivElement>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const keyValueRef = useRef<HTMLInputElement>(null);
  const primaryKeyActionRef = useRef<HTMLButtonElement>(null);
  const deleteKeyRef = useRef<HTMLButtonElement>(null);
  const confirmKeyActionRef = useRef<HTMLButtonElement>(null);
  const logoutRef = useRef<HTMLButtonElement>(null);

  // Requests can settle after the panel has closed; skip state updates then.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ------------------------------------------------------------------ close */

  // The document listeners are registered once, so read `onClose` via a ref.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return undefined;
    }
    const doc = panel.ownerDocument;
    // One physical press produces pointerdown, a compatibility mousedown, then
    // click. Count it once: skip the mousedown that follows a pointerdown, and
    // the click that ends an already-counted press. A lone mousedown or click
    // (keyboard activation, synthetic events) still counts.
    let skipNextMouseDown = false;
    let pressInProgress = false;

    const isOutside = (event: Event): boolean => {
      const { target } = event;
      return !(target instanceof Node && panel.contains(target));
    };
    const close = () => onCloseRef.current();

    const handlePointerDown = (event: Event) => {
      skipNextMouseDown = true;
      pressInProgress = true;
      if (isOutside(event)) {
        close();
      }
    };
    const handleMouseDown = (event: Event) => {
      if (skipNextMouseDown) {
        skipNextMouseDown = false;
        return;
      }
      pressInProgress = true;
      if (isOutside(event)) {
        close();
      }
    };
    const handleClick = (event: Event) => {
      if (pressInProgress) {
        pressInProgress = false;
        return;
      }
      if (isOutside(event)) {
        close();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape closes in every state; during IME composition it belongs to the IME.
      if ((event.key === 'Escape' || event.key === 'Esc') && !event.isComposing) {
        close();
      }
    };

    // Capture phase, so a handler that stops propagation cannot swallow a trigger.
    doc.addEventListener('pointerdown', handlePointerDown, true);
    doc.addEventListener('mousedown', handleMouseDown, true);
    doc.addEventListener('click', handleClick, true);
    doc.addEventListener('keydown', handleKeyDown, true);
    return () => {
      doc.removeEventListener('pointerdown', handlePointerDown, true);
      doc.removeEventListener('mousedown', handleMouseDown, true);
      doc.removeEventListener('click', handleClick, true);
      doc.removeEventListener('keydown', handleKeyDown, true);
    };
  }, []);

  /* ------------------------------------------------------------------ focus */

  // Move focus into the panel on open; give it back to the opener on close.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return undefined;
    }
    const doc = panel.ownerDocument;
    const previous = doc.activeElement;
    const opener =
      previous instanceof HTMLElement && previous !== doc.body ? previous : null;
    panel.focus();
    return () => {
      // Runs before the panel leaves the DOM. Leave focus alone if the student
      // already put it somewhere outside the panel.
      const active = doc.activeElement;
      const focusInPanel = !active || active === doc.body || panel.contains(active);
      if (focusInPanel && opener && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);

  // Focus requests from async handlers, applied after the next render, when the
  // target control exists and is enabled.
  const pendingFocusRef = useRef<{ target: FocusTarget; onlyIfLost: boolean } | null>(
    null
  );
  const [focusTick, setFocusTick] = useState(0);
  const requestFocus = useCallback((target: FocusTarget, onlyIfLost = false) => {
    pendingFocusRef.current = { target, onlyIfLost };
    setFocusTick((tick) => tick + 1);
  }, []);

  useLayoutEffect(() => {
    const request = pendingFocusRef.current;
    const panel = panelRef.current;
    if (!request || !panel) {
      return;
    }
    pendingFocusRef.current = null;
    const targets: Record<FocusTarget, React.RefObject<HTMLElement>> = {
      displayName: displayNameRef,
      keyValue: keyValueRef,
      primaryKeyAction: primaryKeyActionRef,
      deleteKey: deleteKeyRef,
      confirmKeyAction: confirmKeyActionRef,
      logout: logoutRef,
    };
    const element = targets[request.target].current;
    if (!element || !element.isConnected || element.matches(':disabled')) {
      return;
    }
    if (request.onlyIfLost && !isFocusLost(panel)) {
      return;
    }
    element.focus();
  }, [focusTick]);

  // Keep Tab / Shift+Tab inside the dialog.
  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') {
      return;
    }
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = panel.ownerDocument.activeElement;
    if (event.shiftKey) {
      if (active === first || active === panel) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  /* ---------------------------------------------------------------- profile */

  const initialDisplayName = student.displayName ?? '';
  const [savedDisplayName, setSavedDisplayName] = useState(initialDisplayName);
  const [displayNameDraft, setDisplayNameDraft] = useState(initialDisplayName);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>('idle');

  /* ---------------------------------------------------------------- API key */

  const [hasApiKey, setHasApiKey] = useState(student.hasApiKey);
  // The raw key from this panel session's latest generation. Memory only.
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [isKeyVisible, setIsKeyVisible] = useState(true);
  const [keyConfirmation, setKeyConfirmation] = useState<KeyConfirmation | null>(null);
  const [keyBusy, setKeyBusy] = useState<KeyBusy | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState('');

  /* ----------------------------------------------------------------- logout */

  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const profileSaving = profileStatus === 'saving';
  const isDisplayNameDirty = displayNameDraft.trim() !== savedDisplayName.trim();
  const keyControlsDisabled = keyBusy !== null || loggingOut;

  const handleDisplayNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setDisplayNameDraft(event.target.value);
    // Editing clears the previous outcome.
    setDisplayNameError(null);
    if (!profileSaving) {
      setProfileStatus('idle');
    }
  };

  const handleProfileSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (profileSaving || loggingOut || !isDisplayNameDirty) {
      return;
    }
    const result = validateDisplayName(displayNameDraft);
    if (!result.ok) {
      setDisplayNameError(result.error);
      setProfileStatus('idle');
      displayNameRef.current?.focus();
      return;
    }
    setDisplayNameError(null);
    setProfileStatus('saving');
    try {
      await onUpdateProfile(result.value);
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setProfileStatus('error');
      requestFocus('displayName', true);
      return;
    }
    if (!mountedRef.current) {
      return;
    }
    setSavedDisplayName(result.value);
    setDisplayNameDraft(result.value);
    setProfileStatus('saved');
    requestFocus('displayName', true);
  };

  const generateKey = async () => {
    if (keyControlsDisabled) {
      return;
    }
    const retryTarget: FocusTarget = keyConfirmation ? 'confirmKeyAction' : 'primaryKeyAction';
    setKeyBusy('generating');
    setKeyError(null);
    setKeyStatus('');
    let apiKey: string | null = null;
    try {
      apiKey = await onRegenerateApiKey();
    } catch {
      apiKey = null;
    }
    if (!mountedRef.current) {
      return;
    }
    setKeyBusy(null);
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      // The confirmation (if any) stays open so the student can retry or cancel.
      setKeyError(API_KEY_GENERATE_ERROR_MESSAGE);
      requestFocus(retryTarget, true);
      return;
    }
    setKeyConfirmation(null);
    setHasApiKey(true);
    setRevealedKey(apiKey);
    setIsKeyVisible(true);
    setKeyStatus(API_KEY_GENERATED_MESSAGE);
    requestFocus('keyValue');
  };

  const deleteKey = async () => {
    if (keyControlsDisabled) {
      return;
    }
    setKeyBusy('deleting');
    setKeyError(null);
    setKeyStatus('');
    try {
      await onDeleteApiKey();
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setKeyBusy(null);
      setKeyError(API_KEY_DELETE_ERROR_MESSAGE);
      requestFocus('confirmKeyAction', true);
      return;
    }
    if (!mountedRef.current) {
      return;
    }
    setKeyBusy(null);
    setKeyConfirmation(null);
    setHasApiKey(false);
    setRevealedKey(null);
    setKeyStatus(API_KEY_DELETED_MESSAGE);
    requestFocus('primaryKeyAction');
  };

  const openKeyConfirmation = (action: KeyConfirmation) => {
    setKeyError(null);
    setKeyStatus('');
    setKeyConfirmation(action);
  };

  const cancelKeyConfirmation = () => {
    const opener: FocusTarget =
      keyConfirmation === 'delete' ? 'deleteKey' : 'primaryKeyAction';
    setKeyConfirmation(null);
    setKeyError(null);
    requestFocus(opener);
  };

  // A first key is created directly; replacing an existing one is destructive.
  const handlePrimaryKeyAction = () => {
    if (hasApiKey) {
      openKeyConfirmation('regenerate');
    } else {
      void generateKey();
    }
  };

  const handleLogout = async () => {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await onLogout();
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setLoggingOut(false);
      setLogoutError(LOGOUT_ERROR_MESSAGE);
      requestFocus('logout', true);
    }
    // On success the app is leaving for the login screen; stay busy so logout
    // cannot run twice.
  };

  const primaryKeyLabel =
    keyBusy === 'generating' && keyConfirmation === null
      ? 'Generating…'
      : hasApiKey
        ? 'Regenerate key'
        : 'Generate key';

  let confirmActionLabel = '';
  if (keyConfirmation === 'regenerate') {
    confirmActionLabel = keyBusy === 'generating' ? 'Regenerating…' : 'Regenerate';
  } else if (keyConfirmation === 'delete') {
    confirmActionLabel = keyBusy === 'deleting' ? 'Deleting…' : 'Delete';
  }

  return (
    <div
      ref={panelRef}
      className="account-center"
      data-testid="account-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={ids.title}
      aria-busy={loggingOut}
      tabIndex={-1}
      onKeyDown={handlePanelKeyDown}
    >
      <header className="account-center__header">
        <h2 id={ids.title} className="account-center__title">
          Account Center
        </h2>
        <button
          type="button"
          className="account-center__close"
          data-testid="account-center-close"
          aria-label="Close Account Center"
          onClick={() => onClose()}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      {/* Profile: read-only email + editable display name (Requirements 6.1, 6.2). */}
      <section className="account-center__section" aria-labelledby={ids.profileHeading}>
        <h3 id={ids.profileHeading} className="account-center__section-title">
          Profile
        </h3>

        <div className="account-center__field">
          <label className="account-center__label" htmlFor={ids.email}>
            Email
          </label>
          <input
            id={ids.email}
            className="account-center__input account-center__input--readonly"
            data-testid="account-center-email"
            type="email"
            value={student.email}
            readOnly
            aria-describedby={ids.emailHint}
          />
          <p id={ids.emailHint} className="account-center__hint">
            Your university email can&apos;t be changed.
          </p>
        </div>

        <form
          className="account-center__form"
          data-testid="account-center-profile-form"
          aria-busy={profileSaving}
          noValidate
          onSubmit={(event) => {
            void handleProfileSubmit(event);
          }}
        >
          <div className="account-center__field">
            <label className="account-center__label" htmlFor={ids.displayName}>
              Display name
            </label>
            <input
              ref={displayNameRef}
              id={ids.displayName}
              name="displayName"
              className="account-center__input"
              data-testid="account-center-display-name"
              type="text"
              value={displayNameDraft}
              onChange={handleDisplayNameChange}
              readOnly={profileSaving || loggingOut}
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              autoComplete="nickname"
              aria-invalid={displayNameError ? true : undefined}
              aria-describedby={displayNameError ? ids.displayNameError : undefined}
            />
            {displayNameError && (
              <p
                id={ids.displayNameError}
                className="account-center__field-error"
                data-testid="account-center-display-name-error"
              >
                {displayNameError}
              </p>
            )}
          </div>

          {profileStatus === 'error' && (
            <p
              className="account-center__error"
              role="alert"
              data-testid="account-center-profile-error"
            >
              {PROFILE_SAVE_ERROR_MESSAGE}
            </p>
          )}

          <div className="account-center__actions">
            <button
              type="submit"
              className="account-center__button account-center__button--primary"
              data-testid="account-center-save-display-name"
              disabled={!isDisplayNameDirty || profileSaving || loggingOut}
            >
              {profileSaving ? 'Saving…' : 'Save'}
            </button>
            <p
              className="account-center__status"
              role="status"
              data-testid="account-center-profile-status"
            >
              {profileStatus === 'saved' ? PROFILE_SAVED_MESSAGE : ''}
            </p>
          </div>
        </form>
      </section>

      {/* Bedrock API key: view / regenerate / delete (Requirement 6.3). */}
      <section
        className="account-center__section"
        aria-labelledby={ids.keyHeading}
        aria-busy={keyBusy !== null}
      >
        <div className="account-center__section-header">
          <h3 id={ids.keyHeading} className="account-center__section-title">
            Bedrock API key
          </h3>
          <span
            className={`account-center__badge${hasApiKey ? ' account-center__badge--active' : ''}`}
            data-testid="account-center-api-key-status"
            data-has-key={hasApiKey ? 'true' : 'false'}
          >
            {hasApiKey ? 'Active' : 'Not set'}
          </span>
        </div>

        {revealedKey !== null ? (
          <div className="account-center__field">
            <label className="account-center__label" htmlFor={ids.keyValue}>
              Your new API key
            </label>
            <div className="account-center__key-row">
              <input
                ref={keyValueRef}
                id={ids.keyValue}
                className="account-center__input account-center__key-value"
                data-testid="account-center-api-key-value"
                type={isKeyVisible ? 'text' : 'password'}
                value={revealedKey}
                readOnly
                autoComplete="off"
                spellCheck={false}
                aria-describedby={ids.keyWarning}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                type="button"
                className="account-center__button"
                data-testid="account-center-api-key-toggle"
                aria-controls={ids.keyValue}
                onClick={() => setIsKeyVisible((visible) => !visible)}
              >
                {isKeyVisible ? 'Hide key' : 'Show key'}
              </button>
            </div>
            <p
              id={ids.keyWarning}
              className="account-center__hint account-center__hint--warning"
            >
              {API_KEY_ONE_TIME_WARNING}
            </p>
          </div>
        ) : hasApiKey ? (
          <div className="account-center__field">
            <p
              className="account-center__key-masked"
              data-testid="account-center-api-key-masked"
            >
              <span aria-hidden="true">{MASKED_KEY}</span>
              <span className="account-center__visually-hidden">Key hidden</span>
            </p>
            <p className="account-center__hint">
              Keys are shown only once, right after they&apos;re generated.
              Regenerate to get a new one.
            </p>
          </div>
        ) : (
          <p className="account-center__hint" data-testid="account-center-api-key-empty">
            No API key yet. Generate one to power Gus.
          </p>
        )}

        <div className="account-center__actions">
          <button
            ref={primaryKeyActionRef}
            type="button"
            className="account-center__button account-center__button--primary"
            data-testid="account-center-api-key-primary"
            onClick={handlePrimaryKeyAction}
            disabled={keyControlsDisabled || keyConfirmation !== null}
          >
            {primaryKeyLabel}
          </button>
          {hasApiKey && (
            <button
              ref={deleteKeyRef}
              type="button"
              className="account-center__button account-center__button--danger"
              data-testid="account-center-api-key-delete"
              onClick={() => openKeyConfirmation('delete')}
              disabled={keyControlsDisabled || keyConfirmation !== null}
            >
              Delete key
            </button>
          )}
          <p
            className="account-center__status"
            role="status"
            data-testid="account-center-api-key-status-message"
          >
            {keyStatus}
          </p>
        </div>

        {keyConfirmation !== null && (
          <div
            className="account-center__confirm"
            role="group"
            aria-labelledby={ids.keyConfirm}
            data-testid="account-center-api-key-confirm"
            data-action={keyConfirmation}
          >
            <p id={ids.keyConfirm} className="account-center__confirm-text">
              {keyConfirmation === 'regenerate'
                ? 'Regenerate your API key? Your current key stops working immediately.'
                : 'Delete your API key? Gus will stop working until you generate a new one.'}
            </p>
            <div className="account-center__actions">
              <button
                ref={confirmKeyActionRef}
                type="button"
                className="account-center__button account-center__button--danger"
                data-testid="account-center-api-key-confirm-action"
                onClick={() => {
                  void (keyConfirmation === 'regenerate' ? generateKey() : deleteKey());
                }}
                disabled={keyControlsDisabled}
              >
                {confirmActionLabel}
              </button>
              <button
                type="button"
                className="account-center__button"
                data-testid="account-center-api-key-confirm-cancel"
                onClick={cancelKeyConfirmation}
                disabled={keyBusy !== null}
                // Land on the least destructive choice.
                autoFocus
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {keyError && (
          <p
            className="account-center__error"
            role="alert"
            data-testid="account-center-api-key-error"
          >
            {keyError}
          </p>
        )}
      </section>

      {/* Log out (Requirement 6.4). */}
      <footer className="account-center__footer">
        {logoutError && (
          <p
            className="account-center__error"
            role="alert"
            data-testid="account-center-logout-error"
          >
            {logoutError}
          </p>
        )}
        <button
          ref={logoutRef}
          type="button"
          className="account-center__button account-center__button--logout"
          data-testid="account-center-logout"
          onClick={() => {
            void handleLogout();
          }}
          disabled={loggingOut}
        >
          {loggingOut ? 'Logging out…' : 'Log out'}
        </button>
      </footer>
    </div>
  );
};

export default AccountCenter;
