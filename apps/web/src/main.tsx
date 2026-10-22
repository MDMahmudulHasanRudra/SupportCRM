import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app';
import { AuthProvider } from './auth-context';
import './styles.css';
import './theme.css';
import './workspace.css';
import './design-system.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// Apply the user's existing choice to authentication screens too, before React paints the shell.
try {
  const saved = globalThis.localStorage?.getItem('support-crm:theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
} catch { /* System preference remains usable when browser storage is disabled. */ }

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
