import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { Writable } from "stream"
import * as opentype from "opentype.js"
import * as PImage from "pureimage"
import { PREVIEW_FONT_FAMILIES, PREVIEW_LINE_HEIGHT, PREVIEW_PADDING, PreviewTheme, previewFontSize } from "./preview"

/** Rendered PNG plus its pixel size, used by the copy/save actions. */
export interface KaomojiImage {
  buffer: Buffer
  width: number
  height: number
}

export interface LoadableFont {
  /** Family name registered with the rasterizer. */
  family: string
  /** Absolute path to a TTF/OTF file. */
  file: string
}

interface LoadedFont extends LoadableFont {
  font: opentype.Font
}

interface FontMetrics {
  unitsPerEm?: number
  ascender?: number
  descender?: number
  tables?: {
    os2?: {
      usWinAscent?: number
      usWinDescent?: number
    }
  }
}

export const DEFAULT_IMAGE_SCALE = 2
/** Refuse to allocate a canvas larger than this; a single kaomoji never gets close. */
export const MAX_IMAGE_DIMENSION = 16384

const WINDOWS_FONTS = process.env.WINDIR ? path.join(process.env.WINDIR, "Fonts") : "C:\\Windows\\Fonts"
const WINDOWS_USER_FONTS = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts") : ""

function windowsFont(file: string): string[] {
  const files = [WINDOWS_USER_FONTS ? path.join(WINDOWS_USER_FONTS, file) : "", path.join(WINDOWS_FONTS, file)]
  return files.filter(Boolean)
}

/**
 * Candidate font files per CSS family, in the order the browser would consider
 * them. Paths for every platform are listed; statSync filters the missing ones.
 * Color-emoji faces (seguiemj / Noto Color Emoji / Apple Color Emoji) are
 * listed for completeness: their CBDT/COLR glyphs are not outline fonts, so the
 * loader usually skips them and emoji in a kaomoji fall through to a symbol
 * font from EXTRA_FALLBACK_FILES instead.
 */
function familyCandidates(family: string): string[] {
  switch (family.toLowerCase()) {
    case "segoe ui":
      return [
        ...windowsFont("segoeui.ttf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
      ]
    case "microsoft yahei ui":
    case "microsoft yahei":
      // Windows ships both families inside one collection; the loader picks
      // the face whose name table matches the requested family.
      return [...windowsFont("msyh.ttc"), ...windowsFont("msyhl.ttc"), "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"]
    case "pingfang sc":
      return ["/System/Library/Fonts/PingFang.ttc", "/System/Library/AssetsV2/com_apple_MobileAsset_Font8/3419f2a427639ad8c8a11d12cf16a94d3e0d8e9b.asset/AssetData/PingFang.ttc"]
    case "hiragino sans gb":
      return ["/System/Library/Fonts/Hiragino Sans GB.ttc", "/Library/Fonts/Hiragino Sans GB.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"]
    case "noto sans cjk sc":
      return [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.otf",
        ...windowsFont("msyh.ttc")
      ]
    case "noto sans cjk jp":
      return [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansJP-Regular.otf",
        ...windowsFont("YuGothM.ttc"),
        ...windowsFont("msgothic.ttc")
      ]
    case "noto sans jp":
      return [
        "/usr/share/fonts/opentype/noto/NotoSansJP-Regular.otf",
        "/usr/share/fonts/truetype/noto/NotoSansJP-Regular.otf",
        "/usr/share/fonts/truetype/noto/NotoSansJP-Regular.ttf",
        ...windowsFont("YuGothM.ttc"),
        ...windowsFont("meiryo.ttc"),
        ...windowsFont("msgothic.ttc")
      ]
    case "noto sans":
      return [...windowsFont("segoeui.ttf"), "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    case "segoe ui emoji":
      return [...windowsFont("seguiemj.ttf"), "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"]
    case "noto color emoji":
      return ["/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "/usr/share/fonts/truetype/notocoloremoji/NotoColorEmoji.ttf", ...windowsFont("seguiemj.ttf")]
    case "apple color emoji":
      return ["/System/Library/Fonts/Apple Color Emoji.ttc"]
    default:
      // "sans-serif" and any unknown family resolve to the platform default.
      return [
        ...windowsFont("segoeui.ttf"),
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
        "/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf"
      ]
  }
}

/**
 * Fonts outside the CSS stack, consulted only for characters no stack font
 * covers (braille, symbols, Hangul, kana in a face the stack missed).
 * Collections (.ttc) are unpacked by the loader, so MS Gothic / Yu Gothic
 * count even though they are collections.
 */
const EXTRA_FALLBACK_FILES = [
  ...windowsFont("seguisym.ttf"),
  ...windowsFont("seguiemj.ttf"),
  ...windowsFont("malgun.ttf"),
  ...windowsFont("arial.ttf"),
  ...windowsFont("msgothic.ttc"),
  ...windowsFont("YuGothR.ttc"),
  ...windowsFont("meiryo.ttc"),
  "/System/Library/Fonts/Apple Symbols.ttf",
  "/System/Library/Fonts/Supplemental/Apple Symbols.ttf",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansJP-Regular.otf"
]

function firstExisting(files: string[]): string | undefined {
  for (const file of files) {
    try {
      if (fs.statSync(file).isFile()) {
        return file
      }
    } catch {
      // missing font, try the next candidate
    }
  }
  return undefined
}

const COLLECTION_TAG = "ttcf"

/** True for a TrueType/OpenType collection (.ttc/.otc), which opentype.js rejects. */
function isFontCollection(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.toString("latin1", 0, 4) === COLLECTION_TAG
}

function collectionFaceCount(buffer: Buffer): number {
  return buffer.readUInt32BE(8)
}

function collectionFaceOffset(buffer: Buffer, index: number): number {
  const count = collectionFaceCount(buffer)
  if (index < 0 || index >= count) {
    throw new Error(`font collection has no face ${index}`)
  }
  return buffer.readUInt32BE(12 + index * 4)
}

/**
 * Rebuild one face of a collection as a standalone sfnt: opentype.js refuses
 * `ttcf`, and its parser reads tables at offsets relative to the file start.
 * So copy the face's table directory, copy every table after it and point the
 * directory at the new offsets. Exported for tests.
 */
export function extractCollectionFace(buffer: Buffer, index: number): Buffer {
  const faceOffset = collectionFaceOffset(buffer, index)
  const numTables = buffer.readUInt16BE(faceOffset + 4)
  const directorySize = 12 + numTables * 16
  const tables: Array<{ offset: number; length: number; padded: number }> = []
  let size = directorySize
  for (let i = 0; i < numTables; i++) {
    const record = faceOffset + 12 + i * 16
    const length = buffer.readUInt32BE(record + 12)
    const padded = length + ((4 - (length % 4)) % 4)
    tables.push({ offset: buffer.readUInt32BE(record + 8), length, padded })
    size += padded
  }
  const face = Buffer.alloc(size)
  buffer.copy(face, 0, faceOffset, faceOffset + directorySize)
  let writeOffset = directorySize
  for (let i = 0; i < tables.length; i++) {
    buffer.copy(face, writeOffset, tables[i].offset, tables[i].offset + tables[i].length)
    face.writeUInt32BE(writeOffset, 12 + i * 16 + 8)
    writeOffset += tables[i].padded
  }
  return face
}

/** `name` strings are UTF-16BE; Node only decodes little endian directly. */
function decodeNameString(buffer: Buffer, start: number, length: number): string {
  if (length % 2 !== 0) {
    return ""
  }
  const swapped = Buffer.from(buffer.subarray(start, start + length))
  swapped.swap16()
  return swapped.toString("utf16le")
}

/**
 * Family (1), full (4) and typographic family (16) names of one face, read
 * straight from its `name` table. Much cheaper than parsing outlines for every
 * face just to pick one, which matters on Noto CJK collections (~10 faces).
 * Exported for tests.
 */
export function collectionFaceNames(buffer: Buffer, index: number): string[] {
  const faceOffset = collectionFaceOffset(buffer, index)
  const numTables = buffer.readUInt16BE(faceOffset + 4)
  let nameOffset = -1
  for (let i = 0; i < numTables; i++) {
    const record = faceOffset + 12 + i * 16
    if (buffer.toString("latin1", record, record + 4) === "name") {
      nameOffset = buffer.readUInt32BE(record + 8)
      break
    }
  }
  if (nameOffset < 0) {
    return []
  }
  const count = buffer.readUInt16BE(nameOffset + 2)
  const stringOffset = nameOffset + buffer.readUInt16BE(nameOffset + 4)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    const record = nameOffset + 6 + i * 12
    const platformID = buffer.readUInt16BE(record)
    const nameID = buffer.readUInt16BE(record + 6)
    if (nameID !== 1 && nameID !== 4 && nameID !== 16) {
      continue
    }
    const length = buffer.readUInt16BE(record + 8)
    const offset = stringOffset + buffer.readUInt16BE(record + 10)
    if (offset + length > buffer.length) {
      continue
    }
    if (platformID === 0 || platformID === 3) {
      const decoded = decodeNameString(buffer, offset, length)
      if (decoded) {
        names.push(decoded)
      }
    } else if (platformID === 1) {
      names.push(buffer.toString("latin1", offset, offset + length))
    }
  }
  return names
}

/** Strip case, spaces and punctuation: "Microsoft YaHei UI" -> "microsoftyaheiui". */
function normalizeFamily(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

/**
 * Face index for a requested CSS family: exact name match, then a name that
 * starts with the family (full names carry a style suffix), then face 0.
 * Exported for tests.
 */
export function selectCollectionFace(buffer: Buffer, family: string): number {
  const count = collectionFaceCount(buffer)
  const wanted = normalizeFamily(family)
  if (!wanted) {
    return 0
  }
  let partial = -1
  for (let index = 0; index < count; index++) {
    for (const name of collectionFaceNames(buffer, index)) {
      const normalized = normalizeFamily(name)
      if (!normalized) {
        continue
      }
      if (normalized === wanted) {
        return index
      }
      if (partial < 0 && normalized.startsWith(wanted)) {
        partial = index
      }
    }
  }
  return partial >= 0 ? partial : 0
}

/** Reuse the buffer's ArrayBuffer when it already spans all of it. */
function asArrayBuffer(buffer: Buffer): ArrayBuffer {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return buffer.buffer as ArrayBuffer
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

/**
 * Parse one font file, unpacking collections first. Windows only ships kana,
 * halfwidth forms and CJK punctuation inside msyh / msgothic / YuGoth .ttc
 * files; skipping collections made those characters render as .notdef boxes.
 * Exported for tests.
 */
export function loadFontFile(file: string, family: string): opentype.Font {
  const buffer = fs.readFileSync(file)
  if (!isFontCollection(buffer)) {
    return opentype.parse(asArrayBuffer(buffer))
  }
  const face = extractCollectionFace(buffer, selectCollectionFace(buffer, family))
  return opentype.parse(asArrayBuffer(face))
}

/** Ask fontconfig which file Chrome would use for a family on Linux. */
function fontconfigFile(family: string): string | undefined {
  if (process.platform !== "linux") {
    return undefined
  }
  try {
    const file = execFileSync("fc-match", ["-f", "%{file}", family], { encoding: "utf8", timeout: 2000 }).trim()
    return file && fs.existsSync(file) ? file : undefined
  } catch {
    // fc-match is not installed or failed; fall back to the known paths.
    return undefined
  }
}

/**
 * Resolve the preview font stack to real files. Exported for tests.
 * Fonts that several families resolve to are only loaded once.
 */
export function resolveFontStack(): LoadableFont[] {
  const stack: LoadableFont[] = []
  const seen = new Set<string>()
  const add = (family: string, file: string | undefined): void => {
    if (!file) {
      return
    }
    const key = process.platform === "win32" ? file.toLowerCase() : file
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    stack.push({ family, file })
  }
  for (const family of PREVIEW_FONT_FAMILIES) {
    if (process.platform === "linux") {
      add(family, fontconfigFile(family))
    }
    add(family, firstExisting(familyCandidates(family)))
  }
  for (const file of EXTRA_FALLBACK_FILES) {
    add(path.basename(file).replace(/\.[^.]+$/, ""), firstExisting([file]))
  }
  return stack
}

interface StackEntry {
  candidate: LoadableFont
  loaded?: LoadedFont
  failed?: boolean
}

let fontStackEntries: StackEntry[] | undefined
const charFontCache = new Map<string, LoadedFont>()

/** Candidate stack resolved to files once; faces are parsed lazily per use. */
function fontStack(): StackEntry[] {
  if (!fontStackEntries) {
    fontStackEntries = resolveFontStack().map(candidate => ({ candidate }))
  }
  return fontStackEntries
}

/**
 * Parse one stack entry, remembering failures so a broken font is not retried
 * for every character. Copy/save only pays for the faces a kaomoji needs:
 * loading every CJK font up front costs hundreds of milliseconds.
 */
function loadStackEntry(entry: StackEntry): LoadedFont | undefined {
  if (entry.loaded) {
    return entry.loaded
  }
  if (entry.failed) {
    return undefined
  }
  try {
    const font = loadFontFile(entry.candidate.file, entry.candidate.family)
    // Register the parsed face so ctx.font can resolve the family; the font is
    // injected because pureimage would otherwise re-read the path and fail on
    // collections.
    const registered = PImage.registerFont(entry.candidate.file, entry.candidate.family)
    registered.font = font
    registered.loaded = true
    entry.loaded = { family: entry.candidate.family, file: entry.candidate.file, font }
    return entry.loaded
  } catch {
    // Unreadable or unsupported fonts (color-emoji bitmaps, damaged files).
    entry.failed = true
    return undefined
  }
}

/**
 * First face that actually loads, used for the baseline metrics. Also the one
 * place that reports a system without any usable font.
 */
function primaryFont(): LoadedFont {
  for (const entry of fontStack()) {
    const loaded = loadStackEntry(entry)
    if (loaded) {
      return loaded
    }
  }
  throw new Error("No usable font was found on this system")
}

/** Parse the whole stack; only tests and diagnostics need every face. */
export function loadedFontStack(): LoadedFont[] {
  const fonts: LoadedFont[] = []
  for (const entry of fontStack()) {
    const loaded = loadStackEntry(entry)
    if (loaded) {
      fonts.push(loaded)
    }
  }
  return fonts
}

/** Drop cached fonts; only tests need this. */
export function resetImageFontCache(): void {
  fontStackEntries = undefined
  charFontCache.clear()
}

/**
 * On Linux, ask fontconfig for a font covering one specific character and
 * load it on demand. The fixed candidate stack cannot list every script
 * (Thai, for example, appears in kaomoji like ฅ•ω•ฅ), while fontconfig
 * already knows which installed font covers the codepoint.
 */
function fontconfigFontForChar(ch: string): LoadedFont | undefined {
  if (process.platform !== "linux") {
    return undefined
  }
  const codepoint = ch.codePointAt(0)
  if (codepoint === undefined) {
    return undefined
  }
  try {
    const file = execFileSync("fc-match", ["-f", "%{file}", `:charset=${codepoint.toString(16)}`], { encoding: "utf8", timeout: 2000 }).trim()
    if (!file || !fs.existsSync(file)) {
      return undefined
    }
    const entries = fontStack()
    const existing = entries.find(entry => entry.candidate.file === file)
    if (existing) {
      return loadStackEntry(existing)
    }
    const entry: StackEntry = { candidate: { family: path.basename(file), file } }
    entries.push(entry)
    return loadStackEntry(entry)
  } catch {
    return undefined
  }
}

function fontForChar(ch: string): LoadedFont {
  const cached = charFontCache.get(ch)
  if (cached) {
    return cached
  }
  let selected: LoadedFont | undefined
  for (const entry of fontStack()) {
    const loaded = loadStackEntry(entry)
    if (!loaded) {
      continue
    }
    try {
      if (loaded.font.charToGlyph(ch).index !== 0) {
        selected = loaded
        break
      }
    } catch {
      // Ignore fonts that cannot map the character.
    }
  }
  if (!selected) {
    // No stacked font covers this character; try a system fallback before
    // giving up and rendering .notdef (tofu) with the first font.
    selected = fontconfigFontForChar(ch) ?? primaryFont()
  }
  charFontCache.set(ch, selected)
  return selected
}

function advanceFor(font: LoadedFont, ch: string, sizePx: number): number {
  const metrics = font.font as unknown as FontMetrics
  const unitsPerEm = metrics.unitsPerEm || 1000
  if (ch === "\t") {
    return advanceFor(font, " ", sizePx) * 8
  }
  try {
    const advance = font.font.charToGlyph(ch).advanceWidth
    return ((advance ?? unitsPerEm) * sizePx) / unitsPerEm
  } catch {
    return sizePx / 2
  }
}

/** Baseline placement that mirrors the CSS line box used by the preview. */
function verticalMetrics(font: LoadedFont, sizePx: number): { ascent: number; descent: number } {
  const metrics = font.font as unknown as FontMetrics
  const unitsPerEm = metrics.unitsPerEm || 1000
  const os2 = metrics.tables?.os2
  const ascentUnits = os2?.usWinAscent || metrics.ascender || unitsPerEm * 0.8
  const descentUnits = os2?.usWinDescent || Math.abs(metrics.descender || unitsPerEm * 0.2)
  return {
    ascent: (ascentUnits * sizePx) / unitsPerEm,
    descent: (descentUnits * sizePx) / unitsPerEm
  }
}

/**
 * Split the text into the lines the PNG shows: trailing blank lines and
 * trailing spaces only add empty pixels, so they are dropped before sizing
 * the canvas. A kaomoji is normally a single line; embedded newlines are
 * still honored so a multi-line entry renders as-is. Exported for tests.
 */
export function kaomojiImageLines(text: string): string[] {
  const trimmed = text.replace(/\n+$/, "")
  if (!trimmed) {
    return [""]
  }
  return trimmed.split("\n").map(line => line.replace(/[ \t]+$/, ""))
}

function encodePng(image: PImage.Bitmap): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const sink = new Writable({
      write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        chunks.push(chunk)
        callback()
      }
    })
    sink.on("error", reject)
    sink.on("finish", () => resolve(Buffer.concat(chunks)))
    PImage.encodePNGToStream(image, sink).catch(reject)
  })
}

/**
 * Draw one kaomoji to a PNG with the same font stack, size, line height,
 * padding and colors as the webview preview. `scale` defaults to
 * {@link DEFAULT_IMAGE_SCALE} (2) so the image stays crisp on HiDPI displays.
 */
export async function renderKaomojiImage(text: string, theme: PreviewTheme, scale: number = DEFAULT_IMAGE_SCALE): Promise<KaomojiImage> {
  const resolvedScale = Math.max(1, Math.floor(scale))
  const fontSize = previewFontSize(text)
  const sizePx = fontSize * resolvedScale
  const padding = PREVIEW_PADDING * resolvedScale
  const lineHeight = fontSize * PREVIEW_LINE_HEIGHT * resolvedScale
  const lines = kaomojiImageLines(text)

  // The first face that loads also supplies the line metrics. Fonts are parsed
  // lazily, so only the faces the kaomoji actually needs are touched.
  const primary = primaryFont()
  // Warm the per-character cache before measuring so both passes agree.
  const widths = lines.map(line => {
    let width = 0
    for (const ch of line) {
      width += advanceFor(fontForChar(ch), ch, sizePx)
    }
    return width
  })
  const width = Math.ceil(padding * 2 + Math.max(1, ...widths))
  const height = Math.ceil(padding * 2 + lines.length * lineHeight)
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`image is too large (${width}x${height})`)
  }

  const image = PImage.make(width, height)
  const ctx = image.getContext("2d")
  ctx.fillStyle = theme.Background
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = theme.Text
  ctx.textBaseline = "alphabetic"

  const { ascent, descent } = verticalMetrics(primary, sizePx)
  const halfLeading = (lineHeight - (ascent + descent)) / 2
  let baseline = padding + halfLeading + ascent
  for (const line of lines) {
    let x = padding
    let currentFamily = ""
    for (const ch of line) {
      const font = fontForChar(ch)
      if (ch !== " " && ch !== "\t" && ch !== "\u00a0") {
        if (font.family !== currentFamily) {
          ctx.font = `${sizePx} ${font.family}`
          currentFamily = font.family
        }
        ctx.fillText(ch, x, baseline)
      }
      x += advanceFor(font, ch, sizePx)
    }
    baseline += lineHeight
  }

  return { buffer: await encodePng(image), width, height }
}
