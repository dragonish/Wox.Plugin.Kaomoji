import * as fs from "fs"
import * as opentype from "opentype.js"
import { collectionFaceNames, extractCollectionFace, loadedFontStack, loadFontFile, renderKaomojiImage, resetImageFontCache, resolveFontStack, selectCollectionFace } from "../image"
import { buildKaomojiPreview } from "../preview"

function asArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

/** Wrap a plain sfnt in a one-face collection, rebasing its table offsets. */
function wrapAsCollection(sfnt: Buffer): Buffer {
  const headerSize = 16
  const collection = Buffer.alloc(headerSize + sfnt.length)
  collection.write("ttcf", 0, "latin1")
  collection.writeUInt32BE(0x00010000, 4)
  collection.writeUInt32BE(1, 8)
  collection.writeUInt32BE(headerSize, 12)
  sfnt.copy(collection, headerSize)
  const numTables = collection.readUInt16BE(headerSize + 4)
  for (let i = 0; i < numTables; i++) {
    const record = headerSize + 12 + i * 16
    collection.writeUInt32BE(collection.readUInt32BE(record + 8) + headerSize, record + 8)
  }
  return collection
}

/** A real TTF from the resolved stack, so the test does not ship a font. */
function systemTtf(): string | undefined {
  return resolveFontStack().find(font => font.file.toLowerCase().endsWith(".ttf"))?.file
}

/** A real collection from the resolved stack, when the platform ships one. */
function systemCollection(): { family: string; file: string } | undefined {
  return resolveFontStack().find(font => /\.(ttc|otc)$/i.test(font.file))
}

test("renders a kaomoji PNG with real system fonts", async () => {
  const image = await renderKaomojiImage("(≧▽≦)", { Background: "#ffffff", Text: "#111111" })
  expect(image.width).toBeGreaterThan(0)
  expect(image.height).toBeGreaterThan(0)
  // PNG magic bytes
  expect(image.buffer.subarray(0, 4).toString("hex")).toBe("89504e47")
}, 30000)

test("renders kana/symbol kaomoji without throwing", async () => {
  const image = await renderKaomojiImage("ฅ•ω•ฅ", { Background: "#ffffff", Text: "#111111" })
  expect(image.buffer.length).toBeGreaterThan(100)
}, 30000)

test("unpacks one face of a font collection as a standalone font", () => {
  const file = systemTtf()
  if (!file) {
    return
  }
  const sfnt = fs.readFileSync(file)
  const original = opentype.parse(asArrayBuffer(sfnt))
  const collection = wrapAsCollection(sfnt)

  const names = collectionFaceNames(collection, 0)
  expect(names.length).toBeGreaterThan(0)
  expect(selectCollectionFace(collection, names[0])).toBe(0)
  expect(selectCollectionFace(collection, "no such family")).toBe(0)

  const face = opentype.parse(asArrayBuffer(extractCollectionFace(collection, 0)))
  expect(face.unitsPerEm).toBe(original.unitsPerEm)
  expect(face.numGlyphs).toBe(original.numGlyphs)
  expect(face.charToGlyph("A").index).toBe(original.charToGlyph("A").index)
  expect(loadFontFile(file, "unused").numGlyphs).toBe(original.numGlyphs)
})

test("loads a system font collection when the platform ships one", () => {
  const collection = systemCollection()
  if (!collection) {
    return
  }
  expect(() => loadFontFile(collection.file, collection.family)).not.toThrow()
})

// Halfwidth forms and CJK punctuation (｡ ・ ﾉ ｰ) live only in CJK faces, which
// Windows and macOS ship as .ttc collections. Skip when no CJK font is present.
const CJK_FONT = /(msyh|msgothic|yugoth|meiryo|simsun|malgun|pingfang|hiragino|noto.*(cjk|sans ?(sc|jp|tc|kr)))/i
const hasCjkFont = resolveFontStack().some(font => CJK_FONT.test(font.file))

;(hasCjkFont ? test : test.skip)(
  "kaomoji punctuation resolves to a real glyph, not tofu",
  () => {
    resetImageFontCache()
    const fonts = loadedFontStack()
    const missing = Array.from("(j*｡O ‐ O｡)Uﾉ").filter(
      ch =>
        !fonts.some(font => {
          try {
            return font.font.charToGlyph(ch).index !== 0
          } catch {
            return false
          }
        })
    )
    expect(missing).toEqual([])
  },
  30000
)

test("preview is a webview with escaped html and ordered tags", () => {
  const preview = buildKaomojiPreview("<3 & (^^)", [{ Label: "emoticon", Tooltip: "Source" }], { Background: "#000", Text: "#fff" })
  expect(preview.PreviewType).toBe("webview")
  const data = JSON.parse(preview.PreviewData) as { html: string }
  expect(data.html).toContain("&lt;3 &amp;")
  expect(preview.PreviewTags?.[0].Label).toBe("emoticon")
})
