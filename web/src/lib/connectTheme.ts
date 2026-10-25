import { lightTheme, type Theme } from "@rainbow-me/rainbowkit";

// RainbowKit writes these values into a style tag as CSS variables, so they can
// name the site's own tokens. It strips ":;{}<>/" from every value first, which
// rules out slash color syntax such as rgb(r g b / a).
const base = lightTheme({
  accentColor: "var(--color-text)",
  accentColorForeground: "var(--color-accent-contrast)",
  borderRadius: "small",
  overlayBlur: "small",
});

export const connectTheme = {
  ...base,
  colors: {
    ...base.colors,
    actionButtonSecondaryBackground: "var(--color-canvas-deep)",
    closeButton: "var(--color-text)",
    closeButtonBackground: "var(--color-canvas-deep)",
    generalBorder: "var(--color-border)",
    menuItemBackground: "var(--color-canvas-deep)",
    modalBackdrop: "rgba(29, 43, 34, 0.4)",
    modalBackground: "var(--color-surface)",
    modalBorder: "var(--color-border)",
    modalText: "var(--color-text)",
    modalTextDim: "var(--color-text-muted)",
    modalTextSecondary: "var(--color-text-muted)",
  },
  fonts: { body: "var(--font-serif)" },
} satisfies Theme;
