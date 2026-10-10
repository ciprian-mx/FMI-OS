import React, {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  Examination,
  ExaminationTimelineEntry,
  URGENCY_WINDOW_DAYS,
  parseExamDate,
  toTimeline,
} from './examinations';
import {
  EMPTY_EXAMINATION_FORM,
  ExaminationDraft,
  ExaminationFormErrors,
  ExaminationFormField,
  ExaminationFormValues,
  MAX_EXAM_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_SUBJECT_LENGTH,
  formValuesFromExamination,
  validateExaminationForm,
} from './examinationForm';
import './FutureExaminationsApp.css';

/**
 * FutureExaminationsApp timeline view (Task 6.2, Requirements 9.1 / 9.2 / 9.3 / 9.5).
 *
 * Renders the student's examination deadlines as a vertical timeline:
 *   • strictly chronological (Requirement 9.1). Ordering comes from
 *     `toTimeline` (task 6.1, `./examinations`) and is never re-derived here;
 *   • exams ≤ 7 days away carry a visual urgency indicator (Requirement 9.5): a
 *     red accent plus an "Urgent" badge, driven solely by the entry's
 *     `isUrgent` flag from `toTimeline`;
 *   • add / edit / delete controls (Requirements 9.2 / 9.3). Input passes
 *     `validateExaminationForm` (exam name, subject, and date required; notes
 *     optional) before any callback fires, and deletion asks for an inline
 *     confirmation first.
 *
 * Like MaterialsApp, this is the presentational / interaction layer only. The
 * examinations arrive as props and every mutation is surfaced as a callback, so
 * the parent owns data access (the AppSync `examinationsByStudent` query and the
 * create / update / delete mutations) and is expected to update `examinations`
 * once a callback resolves. A rejected callback keeps the UI in place with a
 * retryable error message.
 *
 * Observability (relied on by the Property 12 / 13 tests, tasks 6.3 / 6.4):
 * each timeline entry is exactly one `<li>` inside
 * `data-testid="future-exams-timeline"`, carrying
 * `data-testid="exam-entry-{id}"`, `data-exam-id`, `data-urgent` and
 * `data-past` ("true" | "false"), and an `aria-label` summarizing the exam
 * (ending in ", urgent" when flagged). DOM order is timeline order.
 */

export interface FutureExaminationsAppProps {
  /** The student's examinations, in any order; the timeline sorts them. */
  examinations: readonly Examination[];
  /**
   * Persist a new examination (Requirement 9.2). Receives validated, trimmed
   * input. The "Add exam" control is only rendered when this is provided.
   */
  onAdd?: (exam: ExaminationDraft) => Promise<void> | void;
  /**
   * Persist changes to an existing examination (Requirement 9.3). Receives the
   * full validated set of editable fields. Edit controls are only rendered when
   * this is provided.
   */
  onEdit?: (id: string, updates: ExaminationDraft) => Promise<void> | void;
  /**
   * Delete an examination after the student confirms (Requirement 9.3). Delete
   * controls are only rendered when this is provided.
   */
  onDelete?: (id: string) => Promise<void> | void;
  /**
   * Reference "now" for days-remaining and urgency. Defaults to the current
   * time at render; inject a fixed date for deterministic tests.
   */
  now?: Date;
}

/** Shown in the form when `onAdd` / `onEdit` rejects. */
export const SAVE_ERROR_MESSAGE =
  "Couldn't save the examination. Please try again.";

/** Shown on an entry when `onDelete` rejects. */
export const DELETE_ERROR_MESSAGE =
  "Couldn't delete the examination. Please try again.";

type EditorState = { mode: 'add' } | { mode: 'edit'; id: string };

const EXAM_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatExamDate(date: string): string {
  const time = parseExamDate(date);
  return Number.isNaN(time) ? 'Date unavailable' : EXAM_DATE_FORMAT.format(time);
}

/** Countdown label, read straight off the timeline entry. */
function describeTimeRemaining(entry: ExaminationTimelineEntry): string {
  if (Number.isNaN(entry.daysUntil)) return 'Needs a valid date';
  if (entry.isPast) return 'Past';
  if (entry.daysUntil <= 1) return 'Within 24 hours';
  return `In ${entry.daysUntil} days`;
}

/** Accessible summary of one timeline entry. */
function describeEntry(entry: ExaminationTimelineEntry): string {
  const { examination } = entry;
  const parts = [
    examination.examName,
    examination.subject,
    formatExamDate(examination.date),
    describeTimeRemaining(entry),
  ];
  if (entry.isUrgent) {
    parts.push('urgent');
  }
  return parts.join(', ');
}

/* -------------------------------------------------------------------------- *
 * Add / edit form
 * -------------------------------------------------------------------------- */

/** Field order, used to move focus to the first invalid field on submit. */
const FIELD_ORDER: readonly ExaminationFormField[] = [
  'examName',
  'subject',
  'date',
  'notes',
];

interface ExaminationFormProps {
  mode: EditorState['mode'];
  initialValues: ExaminationFormValues;
  saving: boolean;
  saveError: string | null;
  onSubmit: (draft: ExaminationDraft) => void;
  onCancel: () => void;
}

/**
 * The add / edit form. Owns the draft field values and per-field validation
 * messages; the parent owns the async save (and therefore `saving` /
 * `saveError`). Keyed by the parent per editor session, so switching between
 * add and a particular edit always starts from fresh `initialValues`.
 */
const ExaminationForm: React.FC<ExaminationFormProps> = ({
  mode,
  initialValues,
  saving,
  saveError,
  onSubmit,
  onCancel,
}) => {
  const baseId = useId();
  const [values, setValues] = useState<ExaminationFormValues>(initialValues);
  const [errors, setErrors] = useState<ExaminationFormErrors>({});
  const fieldRefs = useRef<
    Partial<Record<ExaminationFormField, HTMLInputElement | HTMLTextAreaElement | null>>
  >({});

  const titleId = `${baseId}-title`;
  const fieldId = (field: ExaminationFormField) => `${baseId}-${field}`;
  const errorId = (field: ExaminationFormField) => `${baseId}-${field}-error`;

  const handleChange =
    (field: ExaminationFormField) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { value } = event.target;
      setValues((current) => ({ ...current, [field]: value }));
      // Clear a field's message as soon as the student edits it.
      setErrors((current) => {
        if (!current[field]) return current;
        const next = { ...current };
        delete next[field];
        return next;
      });
    };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const result = validateExaminationForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      const firstInvalid = FIELD_ORDER.find((field) => result.errors[field]);
      if (firstInvalid) {
        fieldRefs.current[firstInvalid]?.focus();
      }
      return;
    }
    setErrors({});
    onSubmit(result.value);
  };

  /** Shared value / a11y wiring for each control. */
  const controlProps = (field: ExaminationFormField) => ({
    id: fieldId(field),
    name: field,
    value: values[field],
    onChange: handleChange(field),
    readOnly: saving,
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': errors[field] ? errorId(field) : undefined,
    ref: (element: HTMLInputElement | HTMLTextAreaElement | null) => {
      fieldRefs.current[field] = element;
    },
  });

  const fieldError = (field: ExaminationFormField) =>
    errors[field] ? (
      <p id={errorId(field)} className="future-exams__field-error">
        {errors[field]}
      </p>
    ) : null;

  return (
    <form
      className="future-exams__form"
      data-testid="exam-form"
      data-mode={mode}
      aria-labelledby={titleId}
      aria-busy={saving}
      noValidate
      onSubmit={handleSubmit}
    >
      <h3 id={titleId} className="future-exams__form-title">
        {mode === 'add' ? 'Add examination' : 'Edit examination'}
      </h3>

      <div className="future-exams__field">
        <label className="future-exams__label" htmlFor={fieldId('examName')}>
          Exam name
        </label>
        <input
          {...controlProps('examName')}
          className="future-exams__input"
          type="text"
          required
          maxLength={MAX_EXAM_NAME_LENGTH}
          autoComplete="off"
          // Opening the form is always student-initiated; start on the first field.
          autoFocus
        />
        {fieldError('examName')}
      </div>

      <div className="future-exams__field">
        <label className="future-exams__label" htmlFor={fieldId('subject')}>
          Subject
        </label>
        <input
          {...controlProps('subject')}
          className="future-exams__input"
          type="text"
          required
          maxLength={MAX_SUBJECT_LENGTH}
          autoComplete="off"
        />
        {fieldError('subject')}
      </div>

      <div className="future-exams__field">
        <label className="future-exams__label" htmlFor={fieldId('date')}>
          Date and time
        </label>
        <input
          {...controlProps('date')}
          className="future-exams__input"
          type="datetime-local"
          required
        />
        {fieldError('date')}
      </div>

      <div className="future-exams__field">
        <label className="future-exams__label" htmlFor={fieldId('notes')}>
          Notes (optional)
        </label>
        <textarea
          {...controlProps('notes')}
          className="future-exams__input future-exams__textarea"
          rows={3}
          maxLength={MAX_NOTES_LENGTH}
        />
        {fieldError('notes')}
      </div>

      {saveError && (
        <p
          className="future-exams__form-error"
          role="alert"
          data-testid="exam-form-error"
        >
          {saveError}
        </p>
      )}

      <div className="future-exams__form-actions">
        <button
          type="submit"
          className="future-exams__button future-exams__button--primary"
          data-testid="exam-form-submit"
          disabled={saving}
        >
          {saving ? 'Saving…' : mode === 'add' ? 'Save exam' : 'Save changes'}
        </button>
        <button
          type="button"
          className="future-exams__button"
          data-testid="exam-form-cancel"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </form>
  );
};

/* -------------------------------------------------------------------------- *
 * Timeline entry
 * -------------------------------------------------------------------------- */

interface ExaminationEntryProps {
  entry: ExaminationTimelineEntry;
  isEditing: boolean;
  /** Edit is unavailable while any editor is open or saving. */
  editDisabled: boolean;
  isConfirmingDelete: boolean;
  isDeleting: boolean;
  /** Another entry's deletion is in flight. */
  deleteBusy: boolean;
  hasDeleteError: boolean;
  onEdit?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onRequestDelete?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

const ExaminationEntry: React.FC<ExaminationEntryProps> = ({
  entry,
  isEditing,
  editDisabled,
  isConfirmingDelete,
  isDeleting,
  deleteBusy,
  hasDeleteError,
  onEdit,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}) => {
  const { examination, isUrgent, isPast } = entry;
  const hasValidDate = !Number.isNaN(entry.daysUntil);

  const className = [
    'future-exams__entry',
    isUrgent ? 'future-exams__entry--urgent' : '',
    isPast ? 'future-exams__entry--past' : '',
    hasValidDate ? '' : 'future-exams__entry--invalid',
    isEditing ? 'future-exams__entry--editing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li
      className={className}
      data-testid={`exam-entry-${examination.id}`}
      data-exam-id={examination.id}
      data-urgent={isUrgent ? 'true' : 'false'}
      data-past={isPast ? 'true' : 'false'}
      aria-label={describeEntry(entry)}
    >
      <div className="future-exams__when">
        <time
          className="future-exams__date"
          dateTime={hasValidDate ? examination.date : undefined}
        >
          {formatExamDate(examination.date)}
        </time>
        <span className="future-exams__countdown">
          {describeTimeRemaining(entry)}
        </span>
        {isUrgent && (
          <span
            className="future-exams__urgency"
            data-testid={`exam-urgency-${examination.id}`}
            title={`Exam within ${URGENCY_WINDOW_DAYS} days`}
          >
            <span aria-hidden="true">⚠️</span>
            <span>Urgent</span>
          </span>
        )}
      </div>

      <h3 className="future-exams__name">{examination.examName}</h3>
      <p className="future-exams__subject">{examination.subject}</p>
      {examination.notes && (
        <p className="future-exams__notes">{examination.notes}</p>
      )}

      {(onEdit || onRequestDelete) && (
        <div className="future-exams__actions">
          {onEdit && (
            <button
              type="button"
              className="future-exams__button"
              data-testid={`exam-edit-${examination.id}`}
              aria-label={`Edit ${examination.examName}`}
              onClick={onEdit}
              disabled={editDisabled}
            >
              Edit
            </button>
          )}
          {onRequestDelete && (
            <button
              type="button"
              className="future-exams__button future-exams__button--danger"
              data-testid={`exam-delete-${examination.id}`}
              aria-label={`Delete ${examination.examName}`}
              onClick={onRequestDelete}
              // Stays mounted (but inert) while confirming, so a double click
              // cannot confirm by accident and focus can return here afterwards.
              disabled={isConfirmingDelete || deleteBusy}
            >
              Delete
            </button>
          )}
        </div>
      )}

      {isConfirmingDelete && (
        <div
          className="future-exams__confirm"
          role="group"
          aria-label={`Confirm deletion of ${examination.examName}`}
        >
          <span className="future-exams__confirm-text">
            Delete this examination?
          </span>
          <button
            type="button"
            className="future-exams__button future-exams__button--danger"
            data-testid={`exam-delete-confirm-${examination.id}`}
            aria-label={`Confirm delete ${examination.examName}`}
            onClick={onConfirmDelete}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting…' : 'Delete'}
          </button>
          <button
            type="button"
            className="future-exams__button"
            data-testid={`exam-delete-cancel-${examination.id}`}
            aria-label={`Cancel deleting ${examination.examName}`}
            onClick={onCancelDelete}
            disabled={isDeleting}
            // Land on the least destructive choice.
            autoFocus
          >
            Cancel
          </button>
        </div>
      )}

      {hasDeleteError && (
        <p
          className="future-exams__entry-error"
          role="alert"
          data-testid={`exam-delete-error-${examination.id}`}
        >
          {DELETE_ERROR_MESSAGE}
        </p>
      )}
    </li>
  );
};

/* -------------------------------------------------------------------------- *
 * App
 * -------------------------------------------------------------------------- */

const FutureExaminationsApp: React.FC<FutureExaminationsAppProps> = ({
  examinations,
  onAdd,
  onEdit,
  onDelete,
  now,
}) => {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Ordering and urgency come from the task 6.1 helper, untouched.
  const timeline = toTimeline(examinations, now ?? new Date());

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteErrorId, setDeleteErrorId] = useState<string | null>(null);

  // Focus restoration: when a transient UI (the form or a delete confirmation)
  // closes, return focus to the control that opened it — in the commit that
  // re-enables it, so keyboard users keep their place. Falls back to the app
  // title when that control is gone (e.g. its exam was deleted).
  const editorOpenerRef = useRef<HTMLElement | null>(null);
  const deleteOpenerRef = useRef<HTMLElement | null>(null);
  const pendingFocusRef = useRef<HTMLElement | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  useLayoutEffect(() => {
    if (focusRequest === 0) return;
    const target = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (target && target.isConnected && !target.matches(':disabled')) {
      target.focus();
    } else {
      titleRef.current?.focus();
    }
  }, [focusRequest]);

  const focusAfterRender = useCallback((target: HTMLElement | null) => {
    pendingFocusRef.current = target;
    setFocusRequest((count) => count + 1);
  }, []);

  const openEditor = (
    next: EditorState,
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    editorOpenerRef.current = event.currentTarget;
    setSaveError(null);
    setEditor(next);
  };

  const closeEditor = () => {
    setEditor(null);
    setSaveError(null);
    focusAfterRender(editorOpenerRef.current);
    editorOpenerRef.current = null;
  };

  const handleSubmit = async (draft: ExaminationDraft) => {
    if (!editor || saving) return;
    const current = editor;
    setSaving(true);
    setSaveError(null);
    try {
      if (current.mode === 'add') {
        await onAdd?.(draft);
      } else {
        await onEdit?.(current.id, draft);
      }
    } catch {
      setSaving(false);
      setSaveError(SAVE_ERROR_MESSAGE);
      return;
    }
    setSaving(false);
    closeEditor();
  };

  const requestDelete = (
    id: string,
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    deleteOpenerRef.current = event.currentTarget;
    setDeleteErrorId(null);
    setConfirmingDeleteId(id);
  };

  const cancelDelete = () => {
    setConfirmingDeleteId(null);
    focusAfterRender(deleteOpenerRef.current);
    deleteOpenerRef.current = null;
  };

  const confirmDelete = async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    setDeleteErrorId(null);
    try {
      await onDelete?.(id);
    } catch {
      setDeletingId(null);
      setDeleteErrorId(id);
      return;
    }
    setDeletingId(null);
    setConfirmingDeleteId(null);
    // Nothing is left to edit if the deleted exam was open in the editor.
    setEditor((current) =>
      current && current.mode === 'edit' && current.id === id ? null : current
    );
    focusAfterRender(deleteOpenerRef.current);
    deleteOpenerRef.current = null;
  };

  // The form actually on screen, if any. An edit whose exam has disappeared
  // from `examinations` (e.g. deleted elsewhere) renders nothing and no longer
  // blocks the other controls.
  let form: {
    key: string;
    mode: EditorState['mode'];
    examId: string | null;
    initialValues: ExaminationFormValues;
  } | null = null;
  if (editor?.mode === 'add' && onAdd) {
    form = {
      key: 'add',
      mode: 'add',
      examId: null,
      initialValues: EMPTY_EXAMINATION_FORM,
    };
  } else if (editor?.mode === 'edit' && onEdit) {
    const exam = examinations.find((candidate) => candidate.id === editor.id);
    if (exam) {
      form = {
        key: `edit:${exam.id}`,
        mode: 'edit',
        examId: exam.id,
        initialValues: formValuesFromExamination(exam),
      };
    }
  }
  // One editor at a time: Add / Edit stay inert until it is saved or cancelled.
  const editorBusy = form !== null || saving;

  return (
    <section
      className="future-exams"
      data-testid="future-examinations-app"
      aria-labelledby={titleId}
    >
      <header className="future-exams__header">
        <h2
          id={titleId}
          ref={titleRef}
          className="future-exams__title"
          // Programmatic focus target only (see focus restoration above).
          tabIndex={-1}
        >
          Future Examinations
        </h2>
        {onAdd && (
          <button
            type="button"
            className="future-exams__button future-exams__button--primary"
            data-testid="future-exams-add"
            onClick={(event) => openEditor({ mode: 'add' }, event)}
            disabled={editorBusy}
          >
            Add exam
          </button>
        )}
      </header>

      <div className="future-exams__body">
        {form && (
          <ExaminationForm
            key={form.key}
            mode={form.mode}
            initialValues={form.initialValues}
            saving={saving}
            saveError={saveError}
            onSubmit={handleSubmit}
            onCancel={closeEditor}
          />
        )}

        {timeline.length === 0 ? (
          <p className="future-exams__empty" data-testid="future-exams-empty">
            No examinations yet. Add your upcoming exams to see them on the
            timeline.
          </p>
        ) : (
          <ol
            className="future-exams__timeline"
            data-testid="future-exams-timeline"
            aria-label="Examination timeline"
          >
            {timeline.map((entry) => {
              const { id } = entry.examination;
              return (
                <ExaminationEntry
                  key={id}
                  entry={entry}
                  isEditing={form?.examId === id}
                  editDisabled={editorBusy}
                  isConfirmingDelete={confirmingDeleteId === id}
                  isDeleting={deletingId === id}
                  deleteBusy={deletingId !== null && deletingId !== id}
                  hasDeleteError={deleteErrorId === id}
                  onEdit={
                    onEdit
                      ? (event) => openEditor({ mode: 'edit', id }, event)
                      : undefined
                  }
                  onRequestDelete={
                    onDelete ? (event) => requestDelete(id, event) : undefined
                  }
                  onConfirmDelete={() => {
                    void confirmDelete(id);
                  }}
                  onCancelDelete={cancelDelete}
                />
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
};

export default FutureExaminationsApp;
