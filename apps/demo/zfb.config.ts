import { defineConfig } from "@takazudo/zfb/config";

// Keep raw theme properties in CSS so light/dark changes remain reactive.
// Wide selectors are authored at 68rem, matching the browser media query.
export default defineConfig({
  outDir: "dist",
  publicDir: "public",
  output: "static",
  wind: {
    spec: 1,
    reset: "owned-v1",
    strict: true,
    tokens: {
      colors: {
        page: "var(--color-page)",
        surface: "var(--color-surface)",
        sunken: "var(--color-sunken)",
        ink: "var(--color-ink)",
        muted: "var(--color-muted)",
        subtle: "var(--color-subtle)",
        line: "var(--color-line)",
        "line-strong": "var(--color-line-strong)",
        accent: "var(--color-accent)",
        "accent-hover": "var(--color-accent-hover)",
        "accent-ink": "var(--color-accent-ink)",
        "accent-soft": "var(--color-accent-soft)",
        positive: "var(--color-positive)",
        danger: "var(--color-danger)",
        "positive-ink": "var(--color-positive-ink)",
        "positive-soft": "var(--color-positive-soft)",
        "positive-line": "var(--color-positive-line)",
        "danger-ink": "var(--color-danger-ink)",
        "danger-soft": "var(--color-danger-soft)",
        "danger-line": "var(--color-danger-line)",
        "warning-ink": "var(--color-warning-ink)",
        "warning-soft": "var(--color-warning-soft)",
        "warning-line": "var(--color-warning-line)",
        "ai-ink": "var(--color-ai-ink)",
        "ai-soft": "var(--color-ai-soft)",
        "ai-line": "var(--color-ai-line)",
        "human-ink": "var(--color-human-ink)",
        "human-soft": "var(--color-human-soft)",
        "human-line": "var(--color-human-line)",
      },
      spacing: {
        "3xs": "var(--spacing-3xs)",
        "2xs": "var(--spacing-2xs)",
        xs: "var(--spacing-xs)",
        sm: "var(--spacing-sm)",
        md: "var(--spacing-md)",
        lg: "var(--spacing-lg)",
        xl: "var(--spacing-xl)",
        xxl: "var(--spacing-xxl)",
        control: "var(--spacing-control)",
        icon: "var(--spacing-icon)",
        ui: "var(--spacing-ui)",
        "thumb-sm": "var(--spacing-thumb-sm)",
        thumb: "var(--spacing-thumb)",
        "thumb-lg": "var(--spacing-thumb-lg)",
        panel: "var(--spacing-panel)",
        "bulk-bar": "var(--spacing-bulk-bar)",
      },
      sizes: {
        prose: "var(--container-prose)",
        "screen-2xl": "var(--container-screen-2xl)",
      },
      fontSizes: {
        xs: {
          size: "var(--text-xs)",
        },
        sm: {
          size: "var(--text-sm)",
        },
        body: {
          size: "var(--text-body)",
        },
        title: {
          size: "var(--text-title)",
        },
      },
      fontWeights: {
        semibold: "var(--font-weight-semibold)",
      },
      letterSpacings: {
        tight: "var(--tracking-tight)",
        wide: "var(--tracking-wide)",
      },
      radii: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        pill: "var(--radius-pill)",
      },
      shadows: {
        selected: "var(--shadow-selected)",
        popover: "var(--shadow-popover)",
      },
    },
    authoredClasses: {
      "grid-related-row": true,
      "wide:sticky": true,
      "wide:top-md": true,
      "wide:max-h-panel-viewport": true,
      "wide:grid-workspace-panel": true,
      "wide:overflow-y-auto": true,
      "wide:overscroll-contain": true,
    },
  },
});
