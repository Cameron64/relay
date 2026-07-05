import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement window.matchMedia — Mantine's color-scheme hook (MantineProvider) and
// several components (Modal breakpoints, useMediaQuery) call it unconditionally on mount. Any test
// that renders inside a <MantineProvider> needs this polyfill; PageFrame.test.tsx (relay-roadmap
// Plan 05) is the first to actually mount Mantine components in web/, so it's added here rather
// than per-test.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
