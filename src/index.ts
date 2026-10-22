import { Context, MRUData, Plugin, PluginInitParams, PublicAPI, Query, Result, ResultAction, WoxImage, WoxPreviewTag } from "@wox-launcher/wox-plugin"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { renderKaomojiImage } from "./image"
import { buildIndex, entries, extraTags, findByText, sampleKaomoji, searchKaomoji, subtitleFor, textHash, KaomojiEntry } from "./lib"
import { buildKaomojiPreview, PreviewTheme } from "./preview"

const MAX_LOCAL_RESULTS = 100
const BROWSE_COUNT = 60

const appIcon: WoxImage = {
  ImageType: "relative",
  ImageData: "images/app.svg"
}

let api: PublicAPI

// GetThemeColors costs one round trip per call, so remember the palette for a
// while: a single query response can hold 100 results with previews.
const THEME_CACHE_MS = 5 * 60 * 1000
let themeCache: { theme: PreviewTheme; at: number } | undefined

async function previewTheme(ctx: Context): Promise<PreviewTheme> {
  if (themeCache && Date.now() - themeCache.at < THEME_CACHE_MS) {
    return themeCache.theme
  }
  try {
    const colors = await api.GetThemeColors(ctx, {})
    const theme = { Background: colors.Background, Text: colors.Text }
    themeCache = { theme, at: Date.now() }
    return theme
  } catch {
    return { Background: "#ffffff", Text: "#1f2328" }
  }
}

async function t(ctx: Context, key: string, ...args: string[]): Promise<string> {
  try {
    let raw = await api.GetTranslation(ctx, key)
    if (!raw) {
      raw = key
    }
    for (const arg of args) {
      raw = raw.replace("%s", arg)
    }
    return raw
  } catch {
    return key
  }
}

interface PreviewLabels {
  source: string
  category: string
  tag: string
  description: string
}

async function fetchLabels(ctx: Context): Promise<PreviewLabels> {
  return {
    source: await t(ctx, "preview_label_source"),
    category: await t(ctx, "preview_label_category"),
    tag: await t(ctx, "preview_label_tag"),
    description: await t(ctx, "preview_label_description")
  }
}

function previewTagsFor(entry: KaomojiEntry, labels: PreviewLabels): WoxPreviewTag[] {
  const tags: WoxPreviewTag[] = entry.sources.map(source => ({ Label: source, Tooltip: labels.source }))
  tags.push({ Label: entry.category, Tooltip: labels.category })
  for (const tag of extraTags(entry)) {
    tags.push({ Label: tag, Tooltip: labels.tag })
  }
  if (entry.description) {
    tags.push({ Label: entry.description, Tooltip: labels.description })
  }
  return tags
}

function desktopDir(): string {
  const desktop = path.join(os.homedir(), "Desktop")
  try {
    if (fs.existsSync(desktop) && fs.statSync(desktop).isDirectory()) {
      return desktop
    }
  } catch {
    // fall through to home directory
  }
  return os.homedir()
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function saveToDesktop(text: string, data: string | Buffer, extension: string): string {
  const safe =
    text
      .replace(/[\\/:*?"<>|]/g, "")
      .trim()
      .slice(0, 40) || "kaomoji"
  const now = new Date()
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const filePath = path.join(desktopDir(), `${safe}-${stamp}.${extension}`)
  fs.writeFileSync(filePath, data)
  return filePath
}

function iconFor(entry: KaomojiEntry): WoxImage {
  if (entry.emoji) {
    return { ImageType: "emoji", ImageData: entry.emoji }
  }
  return appIcon
}

function buildActions(entry: KaomojiEntry, uid: string): ResultAction[] {
  const copyAction: ResultAction = {
    // Action ids must be unique within one query response: the Wox host caches
    // action callbacks in a map keyed by Id, so reusing one Id across results
    // makes every result run the last registered callback.
    Id: `copy:${uid}`,
    Name: "i18n:action_copy",
    IsDefault: true,
    ContextData: { text: entry.text },
    Action: async (actionCtx: Context) => {
      await api.Copy(actionCtx, { type: "text", text: entry.text })
      await api.Notify(actionCtx, await t(actionCtx, "notify_copied"))
      await api.HideApp(actionCtx)
    }
  }
  const copyImageAction: ResultAction = {
    Id: `copy-image:${uid}`,
    Name: "i18n:action_copy_image",
    Action: async (actionCtx: Context) => {
      try {
        const image = await renderKaomojiImage(entry.text, await previewTheme(actionCtx))
        await api.Copy(actionCtx, {
          type: "image",
          text: "",
          woxImage: {
            ImageType: "base64",
            ImageData: `data:image/png;base64,${image.buffer.toString("base64")}`
          }
        })
        await api.Notify(actionCtx, await t(actionCtx, "notify_copied_image"))
        await api.HideApp(actionCtx)
      } catch (e) {
        await api.Notify(actionCtx, await t(actionCtx, "error_image_failed", String(e)))
      }
    }
  }
  const saveImageAction: ResultAction = {
    Id: `save-image:${uid}`,
    Name: "i18n:action_save_image",
    Action: async (actionCtx: Context) => {
      try {
        const image = await renderKaomojiImage(entry.text, await previewTheme(actionCtx))
        const filePath = saveToDesktop(entry.text, image.buffer, "png")
        await api.Notify(actionCtx, await t(actionCtx, "notify_saved_image", filePath))
      } catch (e) {
        await api.Notify(actionCtx, await t(actionCtx, "error_image_failed", String(e)))
      }
      await api.HideApp(actionCtx)
    }
  }
  const saveTextAction: ResultAction = {
    Id: `save-text:${uid}`,
    Name: "i18n:action_save",
    Action: async (actionCtx: Context) => {
      try {
        const filePath = saveToDesktop(entry.text, entry.text, "txt")
        await api.Notify(actionCtx, await t(actionCtx, "notify_saved", filePath))
      } catch (e) {
        await api.Notify(actionCtx, await t(actionCtx, "error_save_failed", String(e)))
      }
      await api.HideApp(actionCtx)
    }
  }
  return [copyAction, copyImageAction, saveImageAction, saveTextAction]
}

function buildResult(entry: KaomojiEntry, theme: PreviewTheme, labels: PreviewLabels, uid: string, group?: string): Result {
  const result: Result = {
    Id: `kao:${uid}`,
    Title: entry.text,
    SubTitle: subtitleFor(entry),
    Icon: iconFor(entry),
    // Node.js SDK name for the stable identity the core's MRU hashes by.
    ScoreKey: entry.text,
    Preview: buildKaomojiPreview(entry.text, previewTagsFor(entry, labels), theme),
    Actions: buildActions(entry, uid)
  }
  if (group) {
    result.Group = group
    result.GroupScore = 90
  }
  return result
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    buildIndex()
    try {
      await api.OnMRURestore(ctx, async (restoreCtx: Context, mruData: MRUData) => {
        const text = mruData.ContextData["text"]
        const entry = text ? findByText(text) : undefined
        if (!entry) {
          return null
        }
        const theme = await previewTheme(restoreCtx)
        const labels = await fetchLabels(restoreCtx)
        return buildResult(entry, theme, labels, `mru-${textHash(entry.text)}`)
      })
    } catch {
      // MRU restore is optional; the plugin works without it.
    }
    await api.Log(ctx, "Info", `Kaomoji plugin initialized with ${entries.length} entries`)
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    const search = (query.Search ?? "").trim()
    const theme = await previewTheme(ctx)
    const labels = await fetchLabels(ctx)
    if (!search) {
      return sampleKaomoji(BROWSE_COUNT).map((entry, i) => buildResult(entry, theme, labels, `browse-${i}-${textHash(entry.text)}`))
    }
    const matched = searchKaomoji(search, MAX_LOCAL_RESULTS)
    return matched.map((entry, i) => buildResult(entry, theme, labels, `${i}-${textHash(entry.text)}`))
  }
}
