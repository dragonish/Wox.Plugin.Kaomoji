import { AI, Context, MRUData, Plugin, PluginInitParams, PublicAPI, Query, Result, ResultAction, UpdatableResult, WoxImage, WoxPreviewTag } from "@wox-launcher/wox-plugin"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { renderKaomojiImage } from "./image"
import { aiEntry, buildIndex, entries, extraTags, findByText, sampleKaomoji, searchKaomoji, subtitleFor, textHash, KaomojiEntry } from "./lib"
import { buildKaomojiPreview, PreviewTheme } from "./preview"

const SETTING_AI_ENABLED_KEY = "aiEnabled"
const SETTING_AI_MODEL_KEY = "aiModel"
const MAX_LOCAL_RESULTS = 100
const BROWSE_COUNT = 60
const MAX_AI_RESULTS = 12

const appIcon: WoxImage = {
  ImageType: "relative",
  ImageData: "images/app.svg"
}

let api: PublicAPI
let aiEnabled = false
let aiModel: AI.AIModel | undefined

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

/** Wox stores checkbox values as the strings "true" and "false". */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = (value ?? "").trim().toLowerCase()
  if (normalized === "true" || normalized === "1") {
    return true
  }
  if (normalized === "false" || normalized === "0" || normalized === "") {
    return false
  }
  return fallback
}

/**
 * Parse the JSON stored by a `selectAIModel` setting. Wox serializes the Go
 * model struct as `{ Name, Provider, ProviderAlias }`; older or hand-edited
 * values may use lowercase keys, so both spellings are accepted.
 */
function parseAiModel(raw: string | undefined): AI.AIModel | undefined {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) {
    return undefined
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const pick = (keys: string[]): string => {
      for (const key of keys) {
        const value = parsed[key]
        if (typeof value === "string" && value.trim()) {
          return value.trim()
        }
      }
      return ""
    }
    const name = pick(["Name", "name"])
    const provider = pick(["Provider", "provider"])
    const providerAlias = pick(["ProviderAlias", "providerAlias"])
    if (!name || !provider) {
      return undefined
    }
    return { Name: name, Provider: provider, ProviderAlias: providerAlias || undefined }
  } catch {
    return undefined
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
    ContextData: { text: entry.text, category: entry.category, source: entry.sources.includes("ai") ? "ai" : "" },
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

// ---------------------------------------------------------------------------
// AI matching (optional). Local results return first; a placeholder result is
// updated in place when the LLM stream finishes, and any extra matches are
// pushed afterwards, following Wox's built-in Emoji plugin.
// ---------------------------------------------------------------------------

interface AiItem {
  text: string
  category?: string
}

function parseAiItems(raw: string): AiItem[] {
  const trimmed = raw.trim()
  if (!trimmed) {
    return []
  }
  const candidates = [trimmed]
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1))
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { items?: Array<{ text?: string; category?: string }> }
      if (parsed && Array.isArray(parsed.items)) {
        return parsed.items
          .filter(item => item && typeof item.text === "string" && item.text.trim())
          .map(item => ({ text: (item.text as string).trim(), category: typeof item.category === "string" ? item.category : undefined }))
      }
    } catch {
      // try the next candidate
    }
  }
  // Fallback: scan the raw text for catalog kaomoji that appear in it.
  const found: AiItem[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.text.length < 2 || seen.has(entry.text) || !trimmed.includes(entry.text)) {
      continue
    }
    seen.add(entry.text)
    found.push({ text: entry.text })
    if (found.length >= MAX_AI_RESULTS) {
      break
    }
  }
  return found
}

async function updatePlaceholder(ctx: Context, placeholderId: string, fields: Partial<UpdatableResult>): Promise<void> {
  try {
    const updatable = await api.GetUpdatableResult(ctx, placeholderId)
    if (!updatable) {
      return
    }
    Object.assign(updatable, fields)
    await api.UpdateResult(ctx, updatable)
  } catch {
    // The query may already be gone; AI updates are best-effort.
  }
}

async function failAiPlaceholder(ctx: Context, placeholderId: string): Promise<void> {
  await updatePlaceholder(ctx, placeholderId, {
    Title: await t(ctx, "ai_failed"),
    SubTitle: "",
    Icon: appIcon
  })
}

async function handleAiResult(ctx: Context, query: Query, placeholderId: string, shownTexts: Set<string>, raw: string): Promise<void> {
  const items = parseAiItems(raw)
  const seen = new Set<string>(shownTexts)
  const aiEntries: KaomojiEntry[] = []
  for (const item of items) {
    if (seen.has(item.text)) {
      continue
    }
    seen.add(item.text)
    aiEntries.push(findByText(item.text) ?? aiEntry(item.text, item.category))
    if (aiEntries.length >= MAX_AI_RESULTS) {
      break
    }
  }
  if (aiEntries.length === 0) {
    await updatePlaceholder(ctx, placeholderId, {
      Title: await t(ctx, "ai_no_result"),
      SubTitle: "",
      Icon: appIcon
    })
    return
  }
  const theme = await previewTheme(ctx)
  const labels = await fetchLabels(ctx)
  const group = await t(ctx, "ai_group")
  const results = aiEntries.map((entry, i) => buildResult(entry, theme, labels, `ai-${i}-${textHash(entry.text)}`, group))
  const [first, ...rest] = results
  await updatePlaceholder(ctx, placeholderId, {
    Title: first.Title,
    SubTitle: first.SubTitle,
    Icon: first.Icon,
    Tails: first.Tails,
    Preview: first.Preview,
    Actions: first.Actions
  })
  if (rest.length > 0) {
    try {
      await api.PushResults(ctx, query, rest)
    } catch {
      // best-effort, same as the placeholder update
    }
  }
}

async function startAiMatch(ctx: Context, query: Query, search: string, model: AI.AIModel, placeholderId: string, shownTexts: Set<string>): Promise<void> {
  let settled = false
  let finalData = ""
  const conversations: AI.Conversation[] = [
    { Role: "system", Text: "You are a kaomoji matcher and generator. Return JSON only.", Timestamp: Date.now() },
    {
      Role: "user",
      Text:
        `Query: ${search}\n` +
        `Return JSON: {"items": [{"text": "(≧▽≦)", "category": "happy"}]}. ` +
        `Return up to ${MAX_AI_RESULTS} kaomoji (Japanese emoticons) that match the query's meaning or mood. ` +
        `Prefer well-known kaomoji; you may also generate new ones. Always include a short lowercase category word for each item.`,
      Timestamp: Date.now()
    }
  ]
  try {
    await api.AIChatStream(ctx, model, conversations, { ThinkingMode: "non_thinking" }, streamData => {
      if (streamData.Status === "streaming" || streamData.Status === "streamed") {
        finalData = streamData.Data
        return
      }
      if (streamData.Status === "error") {
        if (!settled) {
          settled = true
          void failAiPlaceholder(ctx, placeholderId)
        }
        return
      }
      if (streamData.Status === "finished") {
        finalData = streamData.Data || finalData
        if (!settled) {
          settled = true
          void handleAiResult(ctx, query, placeholderId, shownTexts, finalData)
        }
      }
    })
  } catch {
    if (!settled) {
      settled = true
      await failAiPlaceholder(ctx, placeholderId)
    }
  }
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    buildIndex()
    // `AIChatStream` with a required model only exists in newer Wox builds.
    // MinWoxVersion stays low because AI is optional; older hosts keep local
    // search and simply skip AI matching.
    const aiSupported = typeof api.AIChatStream === "function"
    try {
      aiEnabled = aiSupported && parseBoolean(await api.GetSetting(ctx, SETTING_AI_ENABLED_KEY), false)
      aiModel = parseAiModel(await api.GetSetting(ctx, SETTING_AI_MODEL_KEY))
      if (!aiSupported) {
        await api.Log(ctx, "Warning", "AI matching is unavailable: this Wox build does not expose AIChatStream")
      } else if (aiEnabled && !aiModel) {
        await api.Log(ctx, "Warning", "AI matching is enabled but no AI model is selected")
      }
    } catch {
      aiEnabled = false
      aiModel = undefined
    }
    try {
      await api.OnSettingChanged(ctx, (_settingCtx, key, value) => {
        if (key === SETTING_AI_ENABLED_KEY) {
          aiEnabled = aiSupported && parseBoolean(value, false)
        } else if (key === SETTING_AI_MODEL_KEY) {
          aiModel = parseAiModel(value)
        }
      })
    } catch {
      // Setting change notifications are best-effort during init.
    }
    try {
      await api.OnMRURestore(ctx, async (restoreCtx: Context, mruData: MRUData) => {
        const text = mruData.ContextData["text"]
        if (!text) {
          return null
        }
        const source = mruData.ContextData["source"]
        const entry = findByText(text) ?? (source === "ai" ? aiEntry(text, mruData.ContextData["category"]) : undefined)
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
    await api.Log(ctx, "Info", `Kaomoji plugin initialized with ${entries.length} entries, AI enabled: ${aiEnabled}`)
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    const search = (query.Search ?? "").trim()
    const theme = await previewTheme(ctx)
    const labels = await fetchLabels(ctx)
    if (!search) {
      return sampleKaomoji(BROWSE_COUNT).map((entry, i) => buildResult(entry, theme, labels, `browse-${i}-${textHash(entry.text)}`))
    }
    const matched = searchKaomoji(search, MAX_LOCAL_RESULTS)
    const results = matched.map((entry, i) => buildResult(entry, theme, labels, `${i}-${textHash(entry.text)}`))
    if (aiEnabled && aiModel && search.length >= 2 && query.Id) {
      const placeholderId = `ai-placeholder:${query.Id}`
      results.push({
        Id: placeholderId,
        Title: await t(ctx, "ai_matching"),
        SubTitle: await t(ctx, "ai_matching_subtitle"),
        Icon: appIcon,
        Group: await t(ctx, "ai_group"),
        GroupScore: 90,
        Actions: []
      })
      const shownTexts = new Set(matched.map(entry => entry.text))
      // Fire and forget: local results must not wait for the LLM stream.
      void startAiMatch(ctx, query, search, aiModel, placeholderId, shownTexts)
    }
    return results
  }
}
