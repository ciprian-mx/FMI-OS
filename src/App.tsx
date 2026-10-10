import React from 'react';
import './App.css';

/**
 * Root application shell. This is an intentionally minimal placeholder for the
 * scaffolding task (1.1). Subsequent tasks replace this with the authentication
 * flow, boot animation, and desktop environment.
 */
const App: React.FC = () => {
  return (
    <div className="app-shell" data-testid="app-shell">
      <main className="app-shell__content">
        <h1>FMI OS</h1>
        <p>Desktop learning environment — scaffolding ready.</p>
      </main>
    </div>
  );
};

export default App;
