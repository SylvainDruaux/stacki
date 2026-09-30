import React from 'react';
import { createRoot } from 'react-dom/client';
import { assert } from '../shared/assert';
import App from './App';
import './styles.css';

const rootElement = document.getElementById('root');
assert(rootElement !== null, 'Renderer root element exists.');
document.documentElement.dataset['platform'] = window.avb.platform;

createRoot(rootElement).render(
  <React.Suspense fallback={undefined}>
    <App />
  </React.Suspense>,
);
