import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import '@fontsource-variable/inter';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
