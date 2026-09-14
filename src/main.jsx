import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// A deployment that is NOT production says so, before anything else renders.
//
// `server.mjs` stamps `<meta name="sb-env">` into the HTML when ENV_LABEL is set, so this
// is here rather than inside App: it has to be true on the sign-in screen too, and it has
// to survive whichever of the five role apps App decides to mount. Production sets no
// label and gets no bar — nothing about the real app changes.
//
// Prepended to <body> rather than rendered inside #root because every screen in this app
// owns its own full-height layout; a bar inside one of them would be a bar inside a
// scrolling region on one screen and pinned on another.
const label = document.querySelector('meta[name="sb-env"]')?.content?.trim();
if (label) {
  const bar = document.createElement('div');
  bar.className = 'env-bar';
  bar.setAttribute('role', 'status');
  bar.textContent = `${label} — test data, not production`;
  document.body.prepend(bar);
  document.body.classList.add('has-env-bar');
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
