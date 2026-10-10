import { render, screen } from '@testing-library/react';
import App from './App';

describe('App shell', () => {
  it('renders the FMI OS heading', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { name: /fmi os/i })
    ).toBeInTheDocument();
  });

  it('mounts the app shell container', () => {
    render(<App />);
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });
});
