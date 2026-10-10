import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FutureExaminationsApp, {
  DELETE_ERROR_MESSAGE,
  SAVE_ERROR_MESSAGE,
} from './FutureExaminationsApp';
import { toDateTimeLocalValue } from './examinationForm';
import { Examination } from './examinations';

/**
 * Task 6.2 — FutureExaminationsApp timeline view.
 *
 * Example-based checks of the rendered timeline: chronological order, the
 * urgency indicator appearing only on exams ≤ 7 days away, and the add / edit /
 * delete flows invoking their callbacks with validated input. `now` is pinned
 * so days-remaining and urgency are deterministic. The universal ordering and
 * urgency invariants (Properties 12 / 13) are property-tested in tasks 6.3 / 6.4.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.5
 */

const NOW = new Date('2024-06-01T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function exam(
  id: string,
  daysFromNow: number,
  overrides: Partial<Examination> = {}
): Examination {
  return {
    id,
    studentId: 'student-1',
    examName: `Exam ${id}`,
    subject: 'Algorithms',
    date: new Date(NOW.getTime() + daysFromNow * DAY_MS).toISOString(),
    notes: null,
    ...overrides,
  };
}

const PAST = exam('past', -12, { examName: 'Logic Exam', subject: 'Logic' });
const SOON = exam('soon', 3, {
  examName: 'Algorithms Midterm',
  notes: 'Chapters 1-4',
});
const BOUNDARY = exam('boundary', 7, { examName: 'OOP Quiz', subject: 'OOP' });
// 7.5 days away rounds up to 8 whole days: just outside the urgency window.
const OUTSIDE = exam('outside', 7.5, { examName: 'Graphs Test', subject: 'Graphs' });
const FAR = exam('far', 30, { examName: 'Databases Final', subject: 'Databases' });

/** Deliberately out of chronological order. */
const ALL = [FAR, SOON, PAST, OUTSIDE, BOUNDARY];

function renderedIds(): (string | null)[] {
  return within(screen.getByTestId('future-exams-timeline'))
    .getAllByRole('listitem')
    .map((item) => item.getAttribute('data-exam-id'));
}

describe('FutureExaminationsApp timeline', () => {
  it('renders examinations in chronological order regardless of input order', () => {
    render(<FutureExaminationsApp examinations={ALL} now={NOW} />);

    expect(renderedIds()).toEqual(['past', 'soon', 'boundary', 'outside', 'far']);

    const soon = screen.getByTestId('exam-entry-soon');
    expect(within(soon).getByText('Algorithms Midterm')).toBeInTheDocument();
    expect(within(soon).getByText('Algorithms')).toBeInTheDocument();
    expect(within(soon).getByText('Chapters 1-4')).toBeInTheDocument();
    expect(within(soon).getByText('In 3 days')).toBeInTheDocument();
    expect(soon.querySelector('time')).toHaveAttribute('datetime', SOON.date);
  });

  it('shows the urgency indicator only on exams within 7 days', () => {
    render(<FutureExaminationsApp examinations={ALL} now={NOW} />);

    const urgentIds = ['soon', 'boundary'];
    for (const { id } of ALL) {
      const entry = screen.getByTestId(`exam-entry-${id}`);
      const urgent = urgentIds.includes(id);
      expect(entry).toHaveAttribute('data-urgent', String(urgent));
      if (urgent) {
        expect(screen.getByTestId(`exam-urgency-${id}`)).toHaveTextContent('Urgent');
        expect(entry).toHaveAccessibleName(/, urgent$/);
      } else {
        expect(screen.queryByTestId(`exam-urgency-${id}`)).not.toBeInTheDocument();
        expect(entry).not.toHaveAccessibleName(/urgent/);
      }
    }
  });

  it('marks past examinations as past', () => {
    render(<FutureExaminationsApp examinations={ALL} now={NOW} />);

    const past = screen.getByTestId('exam-entry-past');
    expect(past).toHaveAttribute('data-past', 'true');
    expect(within(past).getByText('Past')).toBeInTheDocument();
    expect(screen.getByTestId('exam-entry-soon')).toHaveAttribute('data-past', 'false');
  });

  it('shows an empty state when there are no examinations', () => {
    render(<FutureExaminationsApp examinations={[]} now={NOW} />);
    expect(screen.getByTestId('future-exams-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('future-exams-timeline')).not.toBeInTheDocument();
  });

  it('renders no add / edit / delete controls without the callbacks', () => {
    render(<FutureExaminationsApp examinations={ALL} now={NOW} />);
    expect(screen.queryByRole('button', { name: 'Add exam' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });
});

describe('FutureExaminationsApp add flow', () => {
  it('submits validated, trimmed input and closes the form', async () => {
    const user = userEvent.setup();
    const onAdd = jest.fn().mockResolvedValue(undefined);
    render(<FutureExaminationsApp examinations={[]} now={NOW} onAdd={onAdd} />);

    await user.click(screen.getByRole('button', { name: 'Add exam' }));
    const form = screen.getByRole('form', { name: 'Add examination' });
    expect(within(form).getByLabelText('Exam name')).toHaveFocus();

    await user.type(within(form).getByLabelText('Exam name'), '  Algorithms Final ');
    await user.type(within(form).getByLabelText('Subject'), 'Algorithms');
    fireEvent.change(within(form).getByLabelText('Date and time'), {
      target: { value: '2024-06-10T09:30' },
    });
    await user.type(within(form).getByLabelText('Notes (optional)'), 'Bring student ID');
    await user.click(within(form).getByRole('button', { name: 'Save exam' }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith({
      examName: 'Algorithms Final',
      subject: 'Algorithms',
      date: new Date(2024, 5, 10, 9, 30).toISOString(),
      notes: 'Bring student ID',
    });
    await waitFor(() => expect(screen.queryByTestId('exam-form')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add exam' })).toHaveFocus();
  });

  it('blocks submission until exam name, subject, and date are provided', async () => {
    const user = userEvent.setup();
    const onAdd = jest.fn().mockResolvedValue(undefined);
    render(<FutureExaminationsApp examinations={[]} now={NOW} onAdd={onAdd} />);

    await user.click(screen.getByRole('button', { name: 'Add exam' }));
    await user.type(screen.getByLabelText('Exam name'), '   ');
    await user.click(screen.getByRole('button', { name: 'Save exam' }));

    expect(onAdd).not.toHaveBeenCalled();
    const name = screen.getByLabelText('Exam name');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Exam name is required.');
    expect(name).toHaveFocus();
    expect(screen.getByLabelText('Subject')).toHaveAccessibleDescription('Subject is required.');
    expect(screen.getByLabelText('Date and time')).toHaveAccessibleDescription(
      'Date is required.'
    );
    expect(screen.getByLabelText('Notes (optional)')).not.toHaveAttribute('aria-invalid');
  });

  it('keeps the form open with an error when saving fails', async () => {
    const user = userEvent.setup();
    const onAdd = jest.fn().mockRejectedValue(new Error('network down'));
    render(<FutureExaminationsApp examinations={[]} now={NOW} onAdd={onAdd} />);

    await user.click(screen.getByRole('button', { name: 'Add exam' }));
    await user.type(screen.getByLabelText('Exam name'), 'OOP Final');
    await user.type(screen.getByLabelText('Subject'), 'OOP');
    fireEvent.change(screen.getByLabelText('Date and time'), {
      target: { value: '2024-06-20T12:00' },
    });
    await user.click(screen.getByRole('button', { name: 'Save exam' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_ERROR_MESSAGE);
    expect(screen.getByLabelText('Exam name')).toHaveValue('OOP Final');
    expect(screen.getByRole('button', { name: 'Save exam' })).toBeEnabled();
  });

  it('closes without saving on cancel', async () => {
    const user = userEvent.setup();
    const onAdd = jest.fn();
    render(<FutureExaminationsApp examinations={[]} now={NOW} onAdd={onAdd} />);

    await user.click(screen.getByRole('button', { name: 'Add exam' }));
    await user.type(screen.getByLabelText('Exam name'), 'Draft');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByTestId('exam-form')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add exam' })).toHaveFocus();
  });
});

describe('FutureExaminationsApp edit flow', () => {
  it('prefills the selected exam and submits the validated changes', async () => {
    const user = userEvent.setup();
    const onEdit = jest.fn().mockResolvedValue(undefined);
    render(
      <FutureExaminationsApp examinations={[FAR, SOON]} now={NOW} onEdit={onEdit} />
    );

    await user.click(screen.getByRole('button', { name: 'Edit Algorithms Midterm' }));
    const form = screen.getByRole('form', { name: 'Edit examination' });
    expect(within(form).getByLabelText('Exam name')).toHaveValue('Algorithms Midterm');
    expect(within(form).getByLabelText('Subject')).toHaveValue('Algorithms');
    expect(within(form).getByLabelText('Date and time')).toHaveValue(
      toDateTimeLocalValue(SOON.date)
    );
    expect(within(form).getByLabelText('Notes (optional)')).toHaveValue('Chapters 1-4');

    const subject = within(form).getByLabelText('Subject');
    await user.clear(subject);
    await user.type(subject, 'Advanced Algorithms');
    await user.clear(within(form).getByLabelText('Notes (optional)'));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith('soon', {
      examName: 'Algorithms Midterm',
      subject: 'Advanced Algorithms',
      date: SOON.date,
      notes: null,
    });
    await waitFor(() => expect(screen.queryByTestId('exam-form')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Edit Algorithms Midterm' })).toHaveFocus();
  });

  it('rejects an edit that clears a required field', async () => {
    const user = userEvent.setup();
    const onEdit = jest.fn().mockResolvedValue(undefined);
    render(<FutureExaminationsApp examinations={[SOON]} now={NOW} onEdit={onEdit} />);

    await user.click(screen.getByRole('button', { name: 'Edit Algorithms Midterm' }));
    await user.clear(screen.getByLabelText('Exam name'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Exam name')).toHaveAccessibleDescription(
      'Exam name is required.'
    );
  });
});

describe('FutureExaminationsApp delete flow', () => {
  it('deletes only after the student confirms', async () => {
    const user = userEvent.setup();
    const onDelete = jest.fn().mockResolvedValue(undefined);
    render(
      <FutureExaminationsApp examinations={[SOON, FAR]} now={NOW} onDelete={onDelete} />
    );

    await user.click(screen.getByRole('button', { name: 'Delete Algorithms Midterm' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Cancel deleting Algorithms Midterm' })
    ).toHaveFocus();

    await user.click(
      screen.getByRole('button', { name: 'Confirm delete Algorithms Midterm' })
    );

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('soon');
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Confirm delete Algorithms Midterm' })
      ).not.toBeInTheDocument()
    );
  });

  it('keeps the exam when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    const onDelete = jest.fn();
    render(<FutureExaminationsApp examinations={[SOON]} now={NOW} onDelete={onDelete} />);

    await user.click(screen.getByRole('button', { name: 'Delete Algorithms Midterm' }));
    await user.click(
      screen.getByRole('button', { name: 'Cancel deleting Algorithms Midterm' })
    );

    expect(onDelete).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Confirm delete Algorithms Midterm' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Algorithms Midterm' })).toHaveFocus();
  });

  it('shows an error on the entry when deletion fails', async () => {
    const user = userEvent.setup();
    const onDelete = jest.fn().mockRejectedValue(new Error('forbidden'));
    render(<FutureExaminationsApp examinations={[SOON]} now={NOW} onDelete={onDelete} />);

    await user.click(screen.getByRole('button', { name: 'Delete Algorithms Midterm' }));
    await user.click(
      screen.getByRole('button', { name: 'Confirm delete Algorithms Midterm' })
    );

    expect(await screen.findByTestId('exam-delete-error-soon')).toHaveTextContent(
      DELETE_ERROR_MESSAGE
    );
    expect(screen.getByTestId('exam-entry-soon')).toBeInTheDocument();
  });
});
