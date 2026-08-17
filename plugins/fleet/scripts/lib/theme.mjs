const ESC = "\u001b[";

const RGB = Object.freeze({
  ground: [8, 11, 15],
  ink: [231, 237, 242],
  muted: [132, 148, 160],
  dim: [76, 88, 99],
  accent: [94, 215, 242],
  running: [231, 183, 91],
  verified: [111, 213, 154],
  danger: [240, 111, 115]
});

function foreground(rgb) {
  return `${ESC}38;2;${rgb.join(";")}m`;
}

function background(rgb) {
  return `${ESC}48;2;${rgb.join(";")}m`;
}

function paint(open, value) {
  return `${open}${value}${ESC}0m`;
}

export const STATUS_PRESENTATION = Object.freeze({
  queued: { label: "QUEUED", unicode: "○", ascii: "Q", tone: "muted" },
  running: { label: "RUNNING", unicode: "◆", ascii: "R", tone: "running" },
  complete: { label: "COMPLETE", unicode: "◇", ascii: "C", tone: "ink" },
  verified: { label: "VERIFIED", unicode: "✓", ascii: "V", tone: "verified" },
  blocked: { label: "BLOCKED", unicode: "!", ascii: "!", tone: "running" },
  failed: { label: "FAILED", unicode: "×", ascii: "X", tone: "danger" },
  cancelled: { label: "CANCELLED", unicode: "–", ascii: "-", tone: "muted" },
  outcome_unknown: { label: "OUTCOME UNKNOWN", unicode: "?", ascii: "?", tone: "danger" }
});

export function createTheme(preferences = {}) {
  const enabled = preferences.color !== false && preferences.monochrome !== true;
  const codes = enabled
    ? Object.fromEntries(Object.entries(RGB).map(([key, value]) => [key, foreground(value)]))
    : Object.fromEntries(Object.keys(RGB).map((key) => [key, ""]));

  return Object.freeze({
    enabled,
    codes: Object.freeze(codes),
    ground: enabled ? background(RGB.ground) : "",
    eraseLine: enabled ? `${ESC}2K` : "",
    reset: enabled ? `${ESC}0m` : "",
    bold: enabled ? `${ESC}1m` : "",
    paint(tone, value) {
      if (!enabled) return value;
      return paint(codes[tone] ?? codes.ink, value);
    }
  });
}
