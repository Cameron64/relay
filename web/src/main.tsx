import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/tiptap/styles.css';
import './index.css';
import { theme } from './theme';
import { App } from './App';

// Single SW registration (vite-plugin-pwa is configured with injectRegister:null, so the plugin
// does NOT inject its own). The push flow uses navigator.serviceWorker.ready, which this satisfies.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

createRoot(document.getElementById('root')!).render(
  <MantineProvider theme={theme} defaultColorScheme="auto">
    <Notifications position="bottom-center" autoClose={1800} />
    <App />
  </MantineProvider>,
);
