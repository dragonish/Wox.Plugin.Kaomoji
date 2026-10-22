import type { WoxPreview, WoxPreviewTag, WoxPreviewWebviewData } from "@wox-launcher/wox-plugin"

/**
 * Colors of the launcher palette, mirrored from PublicAPI.GetThemeColors.
 * `GetThemeColors` requires Wox >= 2.4.5, so callers must treat this as optional.
 */
export interface PreviewTheme {
  Background: string
  Text: string
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}

/** Escape text for interpolation into HTML. Exported for tests. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch])
}

/** Reverse {@link escapeHtml}. Exported so tests can assert on the rendered text. */
export function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&")
}

const MIN_FONT_SIZE = 14
const MAX_FONT_SIZE = 48
// Approximate content width of the preview panel, minus the body padding.
const AVAILABLE_WIDTH = 400

/** Body padding of the preview; the PNG renderer uses the same value. */
export const PREVIEW_PADDING = 12
/** CSS line-height of the preview, relative to the font size. */
export const PREVIEW_LINE_HEIGHT = 1.3
/**
 * Font stack of the preview, in CSS fallback order. Body fonts come first so
 * kana / CJK / symbols render in a text face; the color-emoji faces are only
 * consulted for glyphs no body font covers. The PNG renderer resolves the
 * same families to font files and falls back per character, so glyphs the
 * primary font lacks keep (approximately) their preview look.
 */
export const PREVIEW_FONT_FAMILIES = [
  "Segoe UI",
  "Microsoft YaHei UI",
  "Microsoft YaHei",
  "PingFang SC",
  "Hiragino Sans GB",
  "Noto Sans CJK SC",
  "Noto Sans CJK JP",
  "Noto Sans JP",
  "Noto Sans",
  "Segoe UI Emoji",
  "Noto Color Emoji",
  "Apple Color Emoji",
  "sans-serif"
]

function cssFontFamily(family: string): string {
  return /\s/.test(family) ? `"${family}"` : family
}

/**
 * Approximate advance width of one code point, in em, for the proportional
 * stack above. ASCII is narrow, CJK / kana / fullwidth / emoji are full width,
 * and other non-ASCII symbols (braille, arrows, math, ...) sit in between.
 * Only used to size the preview; the PNG renderer measures real advances.
 */
function charWidthRatio(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp === 0x20) {
    return 0.33
  }
  if (cp < 0x80) {
    return 0.56
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals, kana, CJK ideographs
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth symbols
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji / pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extension planes
  ) {
    return 1
  }
  return 0.85
}

/** Display width of one line, in em. Exported for tests. */
export function kaomojiLineWidth(line: string): number {
  let width = 0
  for (const ch of line) {
    width += charWidthRatio(ch)
  }
  return width
}

/**
 * Largest font size that keeps the widest line inside the preview panel.
 * Short kaomoji are capped at 48px; long ones shrink down to 14px and are
 * then allowed to wrap (see `pre-wrap` in {@link buildKaomojiPreview}).
 * Exported for tests; the PNG renderer uses the same size so copy/save
 * matches the preview.
 */
export function previewFontSize(text: string): number {
  const widest = text.split("\n").reduce((max, line) => Math.max(max, kaomojiLineWidth(line)), 0)
  if (widest === 0) {
    return MAX_FONT_SIZE
  }
  const fitted = Math.floor(AVAILABLE_WIDTH / widest)
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, fitted))
}

/**
 * Render one kaomoji as a static HTML preview.
 *
 * A `text` preview would render at UI size in a single line of the result
 * list; a `webview` preview shows the kaomoji large and centered, with the
 * font size adapted to its length, so the glyphs (kana, wide symbols,
 * combining marks) stay legible. Wrapping is allowed: `pre-wrap` preserves
 * the significant spaces inside a kaomoji while still breaking an over-long
 * one across lines instead of clipping it.
 *
 * `theme` comes from PublicAPI.GetThemeColors. It is optional: without it
 * the preview stays transparent and follows `prefers-color-scheme` for the
 * text color (same fallback as the figlet plugin's preview).
 *
 * Tags are an array, so their display order is stable (unlike the deprecated
 * PreviewProperties map, whose order the launcher does not preserve).
 */
export function buildKaomojiPreview(text: string, tags: WoxPreviewTag[], theme?: PreviewTheme): WoxPreview {
  const fontSize = previewFontSize(text)
  // A newline directly after the opening tag is at risk of being normalized
  // away; keep a leading one as an entity so the text survives unchanged.
  const body = text.startsWith("\n") ? `&#10;${escapeHtml(text.slice(1))}` : escapeHtml(text)

  const colors = theme ? `background:${theme.Background};color:${theme.Text};` : "background:transparent;color:#1f2328;"
  const darkFallback = theme ? "" : "@media (prefers-color-scheme:dark){body{color:#e6e6e6}}"

  const html = [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    "html,body{margin:0;padding:0}",
    `body{box-sizing:border-box;min-height:100vh;padding:${PREVIEW_PADDING}px;overflow:auto;display:flex;align-items:center;justify-content:center;${colors}}`,
    darkFallback,
    `.kaomoji{margin:0;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere;font-family:${PREVIEW_FONT_FAMILIES.map(cssFontFamily).join(",")};font-size:${fontSize}px;line-height:${PREVIEW_LINE_HEIGHT}}`,
    '</style></head><body><div class="kaomoji">',
    body,
    "</div></body></html>"
  ].join("")

  const data: WoxPreviewWebviewData = { html }
  return {
    PreviewType: "webview",
    PreviewData: JSON.stringify(data),
    PreviewTags: tags
  }
}
