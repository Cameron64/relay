import { createTheme } from '@mantine/core';

// Indigo primary matches Relay's brand (#6366f1 ≈ Mantine indigo). Cohesive radius + system font.
export const theme = createTheme({
  primaryColor: 'indigo',
  defaultRadius: 'md',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  headings: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
});
