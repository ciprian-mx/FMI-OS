import React from 'react';
import { createRoot } from 'react-dom/client';
import { configureAmplify } from './amplifyConfig';
import App from './App';
import './index.css';

// Configure Amplify from the generated aws-exports if present.
// Safe to call before backend resources exist; it no-ops without config.
configureAmplify();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in document');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
