import { Examination } from './examinations';
import {
  EMPTY_EXAMINATION_FORM,
  ExaminationFormValues,
  MAX_EXAM_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_SUBJECT_LENGTH,
  formValuesFromExamination,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
  validateExaminationForm,
} from './examinationForm';

/**
 * Task 6.2 — add / edit form model for the Future Examinations App.
 *
 * Covers the validation gate every add / edit passes (exam name, subject, and
 * date required; notes optional; values trimmed) and the conversion between
 * the `datetime-local` control value (local wall-clock time) and the stored
 * ISO-8601 UTC timestamp. Expected timestamps are built with the local-time
 * `Date` constructor so the assertions hold in any time zone.
 *
 * Validates: Requirements 9.2, 9.3
 */

function values(overrides: Partial<ExaminationFormValues> = {}): ExaminationFormValues {
  return {
    examName: 'Algorithms Final',
    subject: 'Algorithms',
    date: '2024-06-10T09:30',
    notes: '',
    ...overrides,
  };
}

describe('fromDateTimeLocalValue', () => {
  it('reads the control value as local time and returns a UTC ISO timestamp', () => {
    expect(fromDateTimeLocalValue('2024-06-10T09:30')).toBe(
      new Date(2024, 5, 10, 9, 30).toISOString()
    );
  });

  it('accepts optional seconds', () => {
    expect(fromDateTimeLocalValue('2024-06-10T09:30:15')).toBe(
      new Date(2024, 5, 10, 9, 30, 15).toISOString()
    );
  });

  it.each([
    '',
    'tomorrow',
    '2024-06-10',
    '2024-13-01T10:00',
    '2024-02-30T10:00',
    '2024-06-10T24:00',
    '2024-06-10T10:60',
    '0024-06-10T10:00',
  ])('rejects %p', (input) => {
    expect(fromDateTimeLocalValue(input)).toBeNull();
  });
});

describe('toDateTimeLocalValue', () => {
  it('formats a stored timestamp as a local datetime-local value', () => {
    const iso = new Date(2024, 5, 10, 9, 5).toISOString();
    expect(toDateTimeLocalValue(iso)).toBe('2024-06-10T09:05');
  });

  it('round-trips with fromDateTimeLocalValue at minute precision', () => {
    const iso = new Date(2024, 0, 31, 23, 59).toISOString();
    expect(fromDateTimeLocalValue(toDateTimeLocalValue(iso))).toBe(iso);
  });

  it('returns an empty string for an unparseable date', () => {
    expect(toDateTimeLocalValue('nonsense')).toBe('');
  });
});

describe('formValuesFromExamination', () => {
  it('prefills the edit form from a stored examination', () => {
    const exam: Examination = {
      id: 'e1',
      studentId: 'student-1',
      examName: 'Databases Midterm',
      subject: 'Databases',
      date: new Date(2024, 5, 12, 14, 0).toISOString(),
      notes: null,
    };
    expect(formValuesFromExamination(exam)).toEqual({
      examName: 'Databases Midterm',
      subject: 'Databases',
      date: '2024-06-12T14:00',
      notes: '',
    });
  });
});

describe('validateExaminationForm', () => {
  it('returns a trimmed draft with an ISO date for valid input', () => {
    const result = validateExaminationForm(
      values({
        examName: '  Algorithms Final ',
        subject: ' Algorithms ',
        notes: '  Bring student ID  ',
      })
    );
    expect(result).toEqual({
      ok: true,
      value: {
        examName: 'Algorithms Final',
        subject: 'Algorithms',
        date: new Date(2024, 5, 10, 9, 30).toISOString(),
        notes: 'Bring student ID',
      },
    });
  });

  it('normalizes blank notes to null', () => {
    const result = validateExaminationForm(values({ notes: '   ' }));
    expect(result.ok && result.value.notes).toBeNull();
  });

  it('requires exam name, subject, and date but not notes', () => {
    const result = validateExaminationForm({ ...EMPTY_EXAMINATION_FORM });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({
      examName: 'Exam name is required.',
      subject: 'Subject is required.',
      date: 'Date is required.',
    });
  });

  it('treats whitespace-only text as missing', () => {
    const result = validateExaminationForm(values({ examName: '   ', subject: '\t' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['examName', 'subject']);
  });

  it('rejects a date that is not a real calendar date', () => {
    const result = validateExaminationForm(values({ date: '2024-02-30T10:00' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({ date: 'Enter a valid date and time.' });
  });

  it('enforces maximum lengths', () => {
    const result = validateExaminationForm(
      values({
        examName: 'x'.repeat(MAX_EXAM_NAME_LENGTH + 1),
        subject: 'y'.repeat(MAX_SUBJECT_LENGTH + 1),
        notes: 'z'.repeat(MAX_NOTES_LENGTH + 1),
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['examName', 'notes', 'subject']);
  });

  it('accepts values exactly at the maximum lengths', () => {
    const result = validateExaminationForm(
      values({
        examName: 'x'.repeat(MAX_EXAM_NAME_LENGTH),
        subject: 'y'.repeat(MAX_SUBJECT_LENGTH),
        notes: 'z'.repeat(MAX_NOTES_LENGTH),
      })
    );
    expect(result.ok).toBe(true);
  });
});
