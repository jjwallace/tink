// Theme constants and helpers for SettingsPanel.
//
// Two modes — "dark" (translucent charcoal, original) and "aluminum"
// (brushed silver). Each mode publishes its values as CSS custom
// properties on the panel root, so every nested component can read
// them via var(--x). Swapping themes = re-applying the style object.
// Accent colors (PURPLE, GREEN, RED) are theme-invariant — they carry
// semantic meaning so they don't move per mode.

export const FONT =
  "'SF Pro Display', -apple-system, system-ui, sans-serif";

export const ACTIVE_COLOR = "#2b6cb0";
export const PURPLE = "#6c4fd0";
export const GREEN = "#2f8f4b";
export const RED = "#c23a3a";

export type ThemeMode = "dark" | "aluminum";

export interface ThemeVars {
  panelBg: string;
  panelBgImage: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  wellBg: string;
  wellShadow: string;
  edgeHighlight: string;
  edgeShadow: string;
  sectionHeaderBg: string;
  sectionHeaderBorder: string;
  controlBg: string;
  controlBorder: string;
  panelBorder: string;
  backdropAlpha: string;
  chevronSvg: string;
}

export const THEMES: Record<ThemeMode, ThemeVars> = {
  aluminum: {
    panelBg: "#e4e5e7",
    panelBgImage: "none",
    textPrimary: "#1f2226",
    textSecondary: "#4a4e54",
    textMuted: "#7a7e84",
    wellBg: "rgba(0,0,0,0.03)",
    wellShadow: "none",
    edgeHighlight: "rgba(255,255,255,0.45)",
    edgeShadow: "rgba(0,0,0,0.12)",
    sectionHeaderBg: "transparent",
    sectionHeaderBorder: "rgba(0,0,0,0.1)",
    controlBg: "#ffffff",
    controlBorder: "rgba(0,0,0,0.15)",
    panelBorder: "rgba(0,0,0,0.15)",
    backdropAlpha: "rgba(0,0,0,0.25)",
    chevronSvg: "%231f2226",
  },
  dark: {
    panelBg: "rgba(18,18,24,0.96)",
    panelBgImage: "none",
    textPrimary: "rgba(255,255,255,0.92)",
    textSecondary: "rgba(255,255,255,0.60)",
    textMuted: "rgba(255,255,255,0.35)",
    wellBg: "rgba(255,255,255,0.03)",
    wellShadow: "none",
    edgeHighlight: "rgba(255,255,255,0.06)",
    edgeShadow: "rgba(0,0,0,0.35)",
    sectionHeaderBg: "transparent",
    sectionHeaderBorder: "rgba(255,255,255,0.08)",
    controlBg: "rgba(255,255,255,0.05)",
    controlBorder: "rgba(255,255,255,0.12)",
    panelBorder: "rgba(255,255,255,0.08)",
    backdropAlpha: "rgba(0,0,0,0.45)",
    chevronSvg: "%23ffffff",
  },
};

/** Build the CSS-var style object for a given theme. */
export function themeVars(t: ThemeMode): Record<string, string> {
  const v = THEMES[t];
  return {
    "--panel-bg": v.panelBg,
    "--panel-bg-image": v.panelBgImage,
    "--text-primary": v.textPrimary,
    "--text-secondary": v.textSecondary,
    "--text-muted": v.textMuted,
    "--well-bg": v.wellBg,
    "--well-shadow": v.wellShadow,
    "--edge-highlight": v.edgeHighlight,
    "--edge-shadow": v.edgeShadow,
    "--section-header-bg": v.sectionHeaderBg,
    "--section-header-border": v.sectionHeaderBorder,
    "--control-bg": v.controlBg,
    "--control-border": v.controlBorder,
    "--panel-border": v.panelBorder,
    "--backdrop-alpha": v.backdropAlpha,
    "--chevron-svg": v.chevronSvg,
  };
}

const THEME_STORAGE_KEY = "settings-panel-theme";

export function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "aluminum" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return "dark";
}

export function saveTheme(t: ThemeMode) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, t);
  } catch {
    /* ignore */
  }
}
