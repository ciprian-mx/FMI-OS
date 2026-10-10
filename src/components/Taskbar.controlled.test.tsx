import { createRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Taskbar from './Taskbar';

/**
 * The Taskbar's optional controlled "Ask Gus" input (added for task 3.3, so a
 * voice transcription can populate it). Without these props the Taskbar keeps
 * its own draft, as covered by Taskbar.test.tsx.
 */
describe('Taskbar with a controlled "Ask Gus" input', () => {
  it('shows the parent-owned text, reports edits, and asks the parent to clear it after submit', async () => {
    const user = userEvent.setup();
    const onGusQuery = jest.fn<void, [string]>();
    const onGusQueryChange = jest.fn<void, [string]>();
    function Parent() {
      const [query, setQuery] = useState('from voice ');
      return (
        <Taskbar
          gusQuery={query}
          onGusQueryChange={(value) => {
            onGusQueryChange(value);
            setQuery(value);
          }}
          onGusQuery={onGusQuery}
        />
      );
    }
    render(<Parent />);
    const input = screen.getByTestId('taskbar-ask-gus-input');
    expect(input).toHaveValue('from voice ');

    await user.type(input, '!');
    expect(onGusQueryChange).toHaveBeenLastCalledWith('from voice !');
    expect(input).toHaveValue('from voice !');

    await user.keyboard('{Enter}');
    expect(onGusQuery.mock.calls).toEqual([['from voice !']]);
    expect(onGusQueryChange).toHaveBeenLastCalledWith('');
    expect(input).toHaveValue('');
  });

  it('keeps showing the controlled value until the parent changes it', async () => {
    const user = userEvent.setup();
    const onGusQueryChange = jest.fn<void, [string]>();
    render(<Taskbar gusQuery="fixed" onGusQueryChange={onGusQueryChange} />);
    const input = screen.getByTestId('taskbar-ask-gus-input');

    await user.type(input, 'x');

    expect(onGusQueryChange).toHaveBeenCalledWith('fixedx');
    expect(input).toHaveValue('fixed');
  });

  it('accepts a placeholder and exposes the input through gusInputRef', () => {
    const inputRef = createRef<HTMLInputElement>();
    const { rerender } = render(<Taskbar gusInputRef={inputRef} gusPlaceholder="Listening…" />);
    const input = screen.getByTestId('taskbar-ask-gus-input');

    expect(inputRef.current).toBe(input);
    expect(input).toHaveAttribute('placeholder', 'Listening…');

    rerender(<Taskbar gusInputRef={inputRef} />);
    expect(input).toHaveAttribute('placeholder', 'Ask Gus…');
  });
});
