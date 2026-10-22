import { Context, PublicAPI, Query, Result, WoxImage } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"
import { entries, entryCount, findByText, parseQuery, sampleKaomoji, searchKaomoji, subtitleFor } from "../lib"

function mockApi(): PublicAPI {
  return {
    Log: async () => {},
    GetSetting: async () => "false",
    OnSettingChanged: async () => {},
    OnMRURestore: async () => {},
    GetThemeColors: async () => ({
      Background: "#111111",
      Text: "#eeeeee",
      SecondaryText: "",
      Border: "",
      Accent: "",
      AccentText: "",
      Selection: "",
      Dark: true
    }),
    GetTranslation: async (_ctx: Context, key: string) => key
  } as unknown as PublicAPI
}

function makeQuery(search: string): Query {
  return {
    Id: "test-query-1",
    Env: { ActiveWindowTitle: "", ActiveWindowPid: 0, ActiveBrowserUrl: "", ActiveWindowIcon: {} as WoxImage },
    RawQuery: `kao ${search}`,
    Selection: { Type: "text", Text: "", FilePaths: [] },
    Type: "input",
    Search: search,
    TriggerKeyword: "kao",
    Command: "",
    IsGlobalQuery(): boolean {
      return false
    }
  } as Query
}

function matchesToken(entry: (typeof entries)[number], token: string): boolean {
  const fields = [entry.text, entry.category, entry.name ?? "", entry.description ?? ""].concat(entry.tags)
  return fields.some(field => field.toLowerCase().includes(token))
}

function resultTexts(query: string, limit = 100): string[] {
  return searchKaomoji(query, limit).map(entry => entry.text)
}

beforeAll(async () => {
  const ctx = {} as Context
  await plugin.init(ctx, { PluginDirectory: "", API: mockApi() })
})

describe("merged data", () => {
  test("unique entry count matches the expected merge (36070 + 322 - 31)", () => {
    expect(entryCount()).toBe(36361)
  })

  test("texts are unique after merging", () => {
    const texts = new Set(entries.map(e => e.text))
    expect(texts.size).toBe(entries.length)
  })

  test("texts are decoded, not HTML-escaped", () => {
    const escaped = entries.filter(e => /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/.test(e.text))
    expect(escaped.map(e => e.text)).toEqual([])
  })

  test("dual-source overlap is merged into one record", () => {
    const dual = entries.filter(e => e.sources.length === 2)
    expect(dual.length).toBe(31)
    const smiley = findByText(":)")
    expect(smiley).toBeDefined()
    expect(smiley?.sources).toContain("kaomoji")
    expect(smiley?.sources).toContain("emoticon")
  })
})

describe("search", () => {
  test("searching 'cat' hits the cat category", () => {
    const results = searchKaomoji("cat")
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(e => e.category === "cat")).toBe(true)
  })

  test("search is case-insensitive", () => {
    expect(searchKaomoji("CAT").length).toBe(searchKaomoji("cat").length)
  })

  test("':)' resolves to an emoticon entry carrying an emoji", () => {
    const results = searchKaomoji(":)")
    const hit = results.find(e => e.text === ":)")
    expect(hit).toBeDefined()
    expect(hit?.sources).toContain("emoticon")
    expect(hit?.emoji).toBeTruthy()
  })

  test("empty sample returns the browse count", () => {
    expect(sampleKaomoji(60).length).toBe(60)
  })
})

describe("combined query", () => {
  test("parses whitespace-separated plain tokens, drops empty ones and dedupes", () => {
    expect(parseQuery("love\u3000  ^ love")).toEqual([{ value: "love" }, { value: "^" }])
    expect(parseQuery("   ")).toEqual([])
  })

  test("'love ^' keeps entries with love metadata and a caret in the text", () => {
    const results = searchKaomoji("love ^")
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(100)
    for (const entry of results) {
      expect(matchesToken(entry, "love")).toBe(true)
      expect(entry.text.toLowerCase()).toContain("^")
    }
  })

  test("token order and case do not change the result set", () => {
    expect(resultTexts("^ love")).toEqual(resultTexts("love ^"))
    expect(resultTexts("LOVE  ^")).toEqual(resultTexts("love ^"))
  })

  test("one unmatched token returns nothing", () => {
    expect(searchKaomoji("love ^^^not-exist")).toEqual([])
  })

  test("pasting a kaomoji containing spaces still ranks it first", () => {
    const pasted = "( *´ω`* )"
    expect(searchKaomoji(pasted)[0]?.text).toBe(pasted)
  })
})

describe("field filters", () => {
  test("parses known aliases, preserves literal colons and rejects malformed filters", () => {
    expect(parseQuery("TAG:love cat:heart text:^ src:emoticon")).toEqual([
      { field: "tag", value: "love" },
      { field: "cat", value: "heart" },
      { field: "text", value: "^" },
      { field: "src", value: "emoticon" }
    ])
    expect(parseQuery("tags:love category:heart sources:kaomoji")).toEqual([
      { field: "tag", value: "love" },
      { field: "cat", value: "heart" },
      { field: "src", value: "kaomoji" }
    ])
    expect(parseQuery("text::)")).toEqual([{ field: "text", value: ":)" }])
    expect(parseQuery("foo:bar tag: :x")).toEqual([{ value: "foo:bar" }, { value: "tag:" }, { value: ":x" }])
  })

  test("dedupes identical filters but keeps the plain form separate", () => {
    expect(parseQuery("tag:love tag:love love love")).toEqual([{ field: "tag", value: "love" }, { value: "love" }])
  })

  test("tag: only matches tags, using exact/prefix/substring tiers", () => {
    const exact = searchKaomoji("tag:love")
    expect(exact.length).toBe(95)
    for (const entry of exact) {
      expect(entry.tags.map(tag => tag.toLowerCase())).toContain("love")
    }
    expect(searchKaomoji("tag:lov").length).toBe(95)
  })

  test("cat: only matches categories", () => {
    const results = searchKaomoji("cat:heart")
    expect(results.length).toBeGreaterThanOrEqual(68)
    for (const entry of results) {
      expect(entry.category.toLowerCase()).toContain("heart")
    }
    expect(searchKaomoji("cat:cat", 2000).length).toBe(154)
  })

  test("text: only matches the kaomoji text", () => {
    const results = searchKaomoji("text:^", 2000)
    expect(results.length).toBe(1454)
    for (const entry of results) {
      expect(entry.text.toLowerCase()).toContain("^")
    }
    expect(searchKaomoji("text::)").some(entry => entry.text === ":)")).toBe(true)
  })

  test("src: matches the entry source", () => {
    const results = searchKaomoji("src:emoticon", 2000)
    expect(results.length).toBe(322)
    for (const entry of results) {
      expect(entry.sources).toContain("emoticon")
    }
    expect(searchKaomoji("src:e", 2000).length).toBe(322)
    expect(searchKaomoji("src:kaomoji")[0]?.sources).toContain("kaomoji")
  })

  test("filters combine with plain tokens and each other using AND", () => {
    const results = searchKaomoji("tag:love text:^")
    expect(results.length).toBe(6)
    for (const entry of results) {
      expect(entry.tags.map(tag => tag.toLowerCase())).toContain("love")
      expect(entry.text.toLowerCase()).toContain("^")
    }
    expect(searchKaomoji("tag:love cat:heart").length).toBe(3)
    expect(searchKaomoji("tag:love text:@@@")).toEqual([])
  })

  test("filter parsing is case-insensitive", () => {
    expect(resultTexts("TAG:LOVE TEXT:^")).toEqual(resultTexts("tag:love text:^"))
  })
})

describe("subtitle mapping", () => {
  test("kaomoji entries use their category", () => {
    const entry = entries.find(e => e.sources.length === 1 && e.sources[0] === "kaomoji" && !e.name)
    expect(entry).toBeDefined()
    expect(subtitleFor(entry as (typeof entries)[number])).toBe(entry?.category)
  })

  test("emoticon entries use 'name'", () => {
    const heart = findByText("<3")
    expect(heart?.name).toBe("heart")
    expect(subtitleFor(heart as (typeof entries)[number])).toBe("heart")
  })
})

describe("plugin query", () => {
  test("empty query returns browsable results", async () => {
    const results = (await plugin.query({} as Context, makeQuery(""))) as Result[]
    expect(results.length).toBe(60)
  })

  test("search results carry four actions with unique ids and a default copy", async () => {
    const results = (await plugin.query({} as Context, makeQuery("cat"))) as Result[]
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(100)
    const ids = new Set<string>()
    for (const result of results) {
      expect(result.Actions?.length).toBe(4)
      expect(result.Actions?.[0].IsDefault).toBe(true)
      for (const action of result.Actions ?? []) {
        expect(action.Id).toBeTruthy()
        expect(ids.has(action.Id as string)).toBe(false)
        ids.add(action.Id as string)
      }
    }
  })

  test("emoticon results expose the emoji as icon", async () => {
    const results = (await plugin.query({} as Context, makeQuery(":)"))) as Result[]
    const hit = results.find(r => r.Title === ":)")
    expect(hit).toBeDefined()
    expect(hit?.Icon.ImageType).toBe("emoji")
    expect(hit?.Preview?.PreviewType).toBe("webview")
    const tagLabels = (hit?.Preview?.PreviewTags ?? []).map(tag => tag.Label)
    expect(tagLabels).toContain("emoticon")
  })

  test("combined query filters through the plugin", async () => {
    const results = (await plugin.query({} as Context, makeQuery("love ^"))) as Result[]
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(r => r.Title === "LOVE★⌒ヾ(^-'*)")).toBe(true)
    for (const result of results) {
      expect(result.Title.toLowerCase()).toContain("^")
    }
  })

  test("field filters work through the plugin", async () => {
    const filtered = (await plugin.query({} as Context, makeQuery("tag:love text:^"))) as Result[]
    expect(filtered.length).toBe(6)
    for (const result of filtered) {
      expect(result.Title.toLowerCase()).toContain("^")
    }

    const emoticons = (await plugin.query({} as Context, makeQuery("src:emoticon"))) as Result[]
    expect(emoticons.length).toBe(100)
    for (const result of emoticons) {
      expect(result.Icon.ImageType).toBe("emoji")
    }
  })
})
