/**
 * Add / edit form model for the Future Examinations App
 * (Task 6.2, Requirements 9.2 / 9.3).
 *
 * The FutureExaminationsApp lets a student add a new examination (exam name,
 * subject, date, optional notes) and edit an existing one. This module owns the
 * framework-agnostic half of that flow so it can be unit-tested without a DOM:
 *
 *   • {@link validateExaminationForm} — the gate every add/edit passes before
 *     any callback fires: exam name, subject, and date are required, the date
 *     must be a real calendar date and time, and all values are trimmed /
 *     normalized into an {@link ExaminationDraft}.
 *   • {@link fromDateTimeLocalValue} / {@link toDateTimeLocalValue} — convert
 *     between the `<input type="datetime-local">` control value (wall-clock time
 *     in the student's time zone) and the ISO-8601 UTC timestamp stored on the
 *     `Examination` model (`AWSDateTime`).
 *
 * Ordering, days-remaining, and urgency are NOT computed here; they belong to
 * `./examinations` (task 6.1) and are reused by the component as-is.
 */
import { Examination, parseExamDate } from './examinations';

/** Upper bounds keep a single record comfortably small; mirrored as `maxLength`. */
export const MAX_EXAM_NAME_LENGTH = 200;
export const MAX_SUBJECT_LENGTH = 200;
export const MAX_NOTES_LENGTH = 2000;

/**
 * The validated, normalized fields of an examination as entered by the student.
 * Field-compatible with the design's `Omit<Examination, 'id' | 'studentId'>`, so
 * it maps directly onto the AppSync create / update mutation inputs.
 */
export interface ExaminationDraft {
  examName: string;
  subject: string;
  /** ISO-8601 UTC timestamp, e.g. "2024-06-10T06:30:00.000Z". */
  date: string;
  /**
   * Trimmed notes, or `null` when the field was left blank. `null` (rather than
   * omitting the key) lets an edit clear previously saved notes.
   */
  notes: string | null;
}

/** Raw form-control values, exactly as typed by the student. */
export interface ExaminationFormValues {
  examName: string;
  subject: string;
  /** `datetime-local` control value: "YYYY-MM-DDTHH:mm" in local time. */
  date: string;
  notes: string;
}

export type ExaminationFormField = keyof ExaminationFormValues;

/** Per-field, user-renderable validation messages. */
export type ExaminationFormErrors = Partial<Record<ExaminationFormField, string>>;

export type ExaminationFormResult =
  | { ok: true; value: ExaminationDraft }
  | { ok: false; errors: ExaminationFormErrors };

/** Initial values for the "add examination" form. */
export const EMPTY_EXAMINATION_FORM: Readonly<ExaminationFormValues> = {
  examName: '',
  subject: '',
  date: '',
  notes: '',
};

/** "YYYY-MM-DDTHH:mm" with optional ":ss" / ":ss.sss", as the control emits. */
const DATETIME_LOCAL_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * Converts a `datetime-local` control value (wall-clock time in the student's
 * local time zone) to an ISO-8601 UTC timestamp. Returns `null` for anything
 * that is not a real calendar date and time — malformed text, out-of-range
 * fields, or rollover dates such as "2024-02-30T10:00".
 */
export function fromDateTimeLocalValue(value: string): string | null {
  const match = DATETIME_LOCAL_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const local = new Date(year, month - 1, day, hour, minute, second);
  // The Date constructor silently rolls invalid days/months over (Feb 30 →
  // Mar 1) and maps years 0–99 to 1900–1999; reject both by round-tripping.
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== day
  ) {
    return null;
  }
  return local.toISOString();
}

/**
 * Converts a stored ISO-8601 exam date to the `datetime-local` control value
 * ("YYYY-MM-DDTHH:mm", local time) used to prefill the edit form. Returns an
 * empty string for an unparseable date so the student is prompted to fix it.
 */
export function toDateTimeLocalValue(isoDate: string): string {
  const time = parseExamDate(isoDate);
  if (Number.isNaN(time)) {
    return '';
  }
  const d = new Date(time);
  return (
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Prefills the edit form from a stored examination. */
export function formValuesFromExamination(
  exam: Examination
): ExaminationFormValues {
  return {
    examName: exam.examName,
    subject: exam.subject,
    date: toDateTimeLocalValue(exam.date),
    notes: exam.notes ?? '',
  };
}

/**
 * Validates and normalizes raw form values (Requirement 9.2: exam name,
 * subject, and date are required; notes are optional).
 *
 * Text fields are trimmed, so whitespace-only input counts as missing. On
 * success the result carries an {@link ExaminationDraft} with an ISO-8601 UTC
 * `date` and `notes` normalized to `null` when blank; on failure it carries one
 * message per invalid field and no draft.
 */
export function validateExaminationForm(
  values: ExaminationFormValues
): ExaminationFormResult {
  const errors: ExaminationFormErrors = {};

  const examName = values.examName.trim();
  if (examName.length === 0) {
    errors.examName = 'Exam name is required.';
  } else if (examName.length > MAX_EXAM_NAME_LENGTH) {
    errors.examName = `Exam name must be ${MAX_EXAM_NAME_LENGTH} characters or fewer.`;
  }

  const subject = values.subject.trim();
  if (subject.length === 0) {
    errors.subject = 'Subject is required.';
  } else if (subject.length > MAX_SUBJECT_LENGTH) {
    errors.subject = `Subject must be ${MAX_SUBJECT_LENGTH} characters or fewer.`;
  }

  let date: string | null = null;
  if (values.date.trim().length === 0) {
    errors.date = 'Date is required.';
  } else {
    date = fromDateTimeLocalValue(values.date);
    if (date === null) {
      errors.date = 'Enter a valid date and time.';
    }
  }

  const notes = values.notes.trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    errors.notes = `Notes must be ${MAX_NOTES_LENGTH} characters or fewer.`;
  }

  if (date === null || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      examName,
      subject,
      date,
      notes: notes.length > 0 ? notes : null,
    },
  };
}
