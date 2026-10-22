#!/usr/bin/env node
/**
 * generate-data.mjs — data pipeline for the Wox kaomoji plugin
 *
 * Merges two MIT-licensed data sources into the plugin's unified
 * data file src/data.json.
 *
 * Data sources (must be installed in node_modules as devDependencies):
 * - kaomoji-collection: node_modules/kaomoji-collection/kaomoji.json
 *   Shape { [category: string]: string[] }; the same text may appear
 *   in multiple categories.
 * - emoticon (wooorm, ESM): node_modules/emoticon/index.js
 *   export const emoticon: Array<{
 *     description: string, emoji: string, emoticons: string[],
 *     name: string, tags: string[]
 *   }>
 *
 * Usage (run in the plugin project root):
 * npm install -D kaomoji-collection emoticon
 * node scripts/generate-data.mjs
 *
 * Path conventions:
 * - This script lives at scripts/generate-data.mjs in the plugin project;
 * - project root = the parent directory of scripts/; inputs are read
 *   from <root>/node_modules/, and the output goes to <root>/src/data.json
 *   (the directory is created automatically if missing).
 * - Also works when the script is placed directly in the project root:
 *   if the script's own directory contains node_modules/, that directory
 *   is treated as the project root. Both layouts work.
 *
 * Unified entry (empty fields are omitted: undefined / empty string /
 * empty array are not emitted):
 * {
 *   text: string,
 *   sources: Array<'kaomoji' | 'emoticon'>,
 *   category: string,
 *   name?: string,        // emoticon source only
 *   description?: string, // emoticon source only
 *   tags: string[],       // see merge rules; field omitted when empty
 *   emoji?: string,       // emoticon source only
 * }
 *
 * Merge rules:
 * 0. HTML character references are decoded before anything else (kaomoji-
 *    collection ships part of its texts escaped, e.g. `&lt;3` or `&#x27;`,
 *    and a few are even double-escaped: `&amp;lt;`). Decoding happens first
 *    so escaped and plain spellings of the same kaomoji collapse into one
 *    entry; unknown references are kept verbatim.
 * 1. kaomoji is expanded first: categories are visited in kaomoji.json
 *    order, each text is kept only once, category is its first owning
 *    category, and all owning categories (deduped, order preserved)
 *    are merged into tags.
 * 2. emoticon is expanded second: category = group.name, and
 *    name / description / tags / emoji are carried over as-is.
 * 3. Entries are merged by text across sources: sources becomes
 *    ['kaomoji', 'emoticon'], category keeps the first-seen value
 *    (i.e. the kaomoji first owning category), name / description /
 *    emoji are filled in from emoticon, and tags is the union of both
 *    sources' tags (deduped, order preserved, kaomoji categories first).
 * 4. Output order is first-appearance order (kaomoji first,
 *    emoticon-only entries appended after); the result is fully
 *    deterministic for the same input.
 *
 * Uses only Node.js built-in modules, no runtime dependencies
 * (Node >= 16 is enough).
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

// Resolve the project root: under scripts/ -> parent directory;
// if the script sits in the root itself -> the script's own directory.
const projectRoot = existsSync(path.join(scriptDir, "node_modules")) ? scriptDir : path.resolve(scriptDir, "..")

const kaomojiJsonPath = path.join(projectRoot, "node_modules/kaomoji-collection/kaomoji.json")
const emoticonModulePath = path.join(projectRoot, "node_modules/emoticon/index.js")
const outputPath = path.join(projectRoot, "src/data.json")

/** Append value to the list unless already present (deduped, order preserved); no-op when value is empty. */
function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value)
}

// ---- HTML entity decoding ----
// The upstream kaomoji-collection data is partly HTML-escaped, so the texts
// have to be normalized before they are used as merge keys. Only the
// references actually present upstream are handled; anything else is left
// untouched instead of being guessed at.

/** Named references that occur in the upstream data. */
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

/** One character reference: decimal, hexadecimal, or a named one. */
const ENTITY_PATTERN = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g

/** Code points that must not be decoded: out of range, NUL, lone surrogates. */
function isValidCodePoint(cp) {
  return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
}

/** Decode a single layer of references; unknown ones are returned unchanged. */
function decodeEntitiesOnce(text) {
  return text.replace(ENTITY_PATTERN, (match, decimal, hex, name) => {
    if (decimal !== undefined) {
      const cp = Number(decimal)
      return isValidCodePoint(cp) ? String.fromCodePoint(cp) : match
    }
    if (hex !== undefined) {
      const cp = Number.parseInt(hex, 16)
      return isValidCodePoint(cp) ? String.fromCodePoint(cp) : match
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match
  })
}

/** Safety net for pathological input; real data needs at most two passes. */
const MAX_ENTITY_PASSES = 5

/**
 * Decode HTML character references until the text stops changing, which also
 * resolves double-escaped texts (`&amp;gt;` -> `&gt;` -> `>`).
 */
function decodeHtmlEntities(text) {
  if (!text.includes("&")) return text
  let decoded = text
  for (let pass = 0; pass < MAX_ENTITY_PASSES; pass++) {
    const next = decodeEntitiesOnce(decoded)
    if (next === decoded) break
    decoded = next
  }
  return decoded
}

/** Decode an optional string field (non-strings pass through untouched). */
function decodeOptional(value) {
  return typeof value === "string" ? decodeHtmlEntities(value) : value
}

/** Build the final output object: fixed key order, empty fields omitted. */
function finalize(entry) {
  const out = { text: entry.text, sources: entry.sources, category: entry.category }
  if (entry.name) out.name = entry.name
  if (entry.description) out.description = entry.description
  if (entry.tags.length > 0) out.tags = entry.tags
  if (entry.emoji) out.emoji = entry.emoji
  return out
}

async function main() {
  // ---- Read kaomoji-collection ----
  let kaomojiDict
  try {
    kaomojiDict = JSON.parse(await readFile(kaomojiJsonPath, "utf8"))
  } catch {
    throw new Error(`Kaomoji data not found: ${kaomojiJsonPath}\n` + "Please run in the project root first: npm install -D kaomoji-collection emoticon")
  }

  // ---- Read emoticon (ESM) ----
  let emoticonGroups
  try {
    ;({ emoticon: emoticonGroups } = await import(pathToFileURL(emoticonModulePath).href))
  } catch {
    throw new Error(`Emoticon data not found: ${emoticonModulePath}\n` + "Please run in the project root first: npm install -D kaomoji-collection emoticon")
  }
  if (!Array.isArray(emoticonGroups)) {
    throw new Error("The emoticon package did not export an `emoticon` array; the data source layout has changed")
  }

  /** @type {Map<string, object>} text -> unified entry (insertion order is the output order) */
  const byText = new Map()
  let kaomojiRaw = 0
  let emoticonRaw = 0
  let decodedKaomoji = 0
  let decodedEmoticon = 0

  // ---- 1) Expand kaomoji: decode entity-escaped texts, dedupe across categories, merge all owning categories into tags ----
  for (const [category, texts] of Object.entries(kaomojiDict)) {
    if (!Array.isArray(texts)) continue
    for (const rawText of texts) {
      if (typeof rawText !== "string" || rawText.length === 0) continue
      kaomojiRaw++
      const text = decodeHtmlEntities(rawText)
      if (text !== rawText) decodedKaomoji++
      const existing = byText.get(text)
      if (!existing) {
        byText.set(text, {
          text,
          sources: ["kaomoji"],
          category, // first owning category
          tags: [category]
        })
      } else {
        // Already produced by kaomoji (emoticon not processed yet): add this owning category to tags
        pushUnique(existing.tags, category)
      }
    }
  }
  const kaomojiUnique = byText.size

  // ---- 2) Expand emoticon and merge by text ----
  for (const group of emoticonGroups) {
    if (!group || !Array.isArray(group.emoticons)) continue
    // Group metadata is decoded once and reused for every text of the group.
    const groupName = decodeOptional(group.name)
    const groupDescription = decodeOptional(group.description)
    const groupEmoji = decodeOptional(group.emoji)
    const groupTags = [...new Set((group.tags ?? []).map(decodeOptional))]
    for (const rawText of group.emoticons) {
      if (typeof rawText !== "string" || rawText.length === 0) continue
      emoticonRaw++
      const text = decodeHtmlEntities(rawText)
      if (text !== rawText) decodedEmoticon++
      const existing = byText.get(text)
      if (!existing) {
        byText.set(text, {
          text,
          sources: ["emoticon"],
          category: groupName,
          name: groupName || undefined,
          description: groupDescription || undefined,
          tags: [...groupTags],
          emoji: groupEmoji || undefined
        })
      } else {
        // Present in both sources (or the same text across emoticon groups, which does not occur in the current data):
        // keep the first-seen category; for the remaining fields the first emoticon group wins.
        if (!existing.sources.includes("emoticon")) {
          existing.sources.push("emoticon")
        }
        if (!existing.name && groupName) existing.name = groupName
        if (!existing.description && groupDescription) {
          existing.description = groupDescription
        }
        if (!existing.emoji && groupEmoji) existing.emoji = groupEmoji
        for (const tag of groupTags) pushUnique(existing.tags, tag)
      }
    }
  }

  // ---- Output ----
  const entries = [...byText.values()].map(finalize)

  // Safety net: decoding already ran, so anything that still changes means the
  // upstream data uses a reference this script does not know about. Warn only:
  // such texts are still usable as-is.
  const unresolved = entries.filter(e => decodeHtmlEntities(e.text) !== e.text)
  if (unresolved.length > 0) {
    console.warn(
      `warning: ${unresolved.length} texts still contain HTML character references after decoding, e.g. ` +
        JSON.stringify(unresolved.slice(0, 3).map(e => e.text))
    )
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  const json = JSON.stringify(entries) // compact format; imported/required directly by the plugin
  await writeFile(outputPath, json + "\n", "utf8")

  // ---- Stats ----
  const dual = entries.filter(e => e.sources.length === 2).length
  const onlyKaomoji = entries.filter(e => e.sources.length === 1 && e.sources[0] === "kaomoji").length
  const onlyEmoticon = entries.filter(e => e.sources.length === 1 && e.sources[0] === "emoticon").length
  const bytes = Buffer.byteLength(json + "\n", "utf8")

  console.log(`kaomoji: ${kaomojiRaw} raw / ${kaomojiUnique} unique`)
  console.log(`emoticon: ${emoticonRaw} raw / ${emoticonGroups.length} groups`)
  console.log(`html entities decoded: ${decodedKaomoji} kaomoji / ${decodedEmoticon} emoticon texts`)
  console.log(`in both sources: ${dual}`)
  console.log(`merged total: ${entries.length} (kaomoji only ${onlyKaomoji} / emoticon only ${onlyEmoticon} / both ${dual})`)
  console.log(`output: ${outputPath} (${bytes} bytes)`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
