import { AI, Context, MRUData, PublicAPI, Query, Result, UpdatableResult, WoxImage } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"

const MODEL_JSON = JSON.stringify({ Name: "test-model", Provider: "openai", ProviderAlias: "work" })

type StreamHandler = (callback: AI.ChatStreamFunc) => void

interface MockApi {
  api: PublicAPI
  updated: UpdatableResult[]
  pushed: Result[][]
  streams: Array<{ model: AI.AIModel; conversations: AI.Conversation[]; options: AI.ChatOptions }>
}

function makeApi(settings: Record<string, string>, stream?: StreamHandler): MockApi {
  const updated: UpdatableResult[] = []
  const pushed: Result[][] = []
  const streams: MockApi["streams"] = []
  const api = {
    Log: async (): Promise<void> => {},
    GetSetting: async (_ctx: Context, key: string): Promise<string> => settings[key] ?? "",
    OnSettingChanged: async (): Promise<void> => {},
    OnMRURestore: async (): Promise<void> => {},
    GetThemeColors: async (): Promise<Record<string, unknown>> => ({
      Background: "#111111",
      Text: "#eeeeee",
      SecondaryText: "",
      Border: "",
      Accent: "",
      AccentText: "",
      Selection: "",
      Dark: true
    }),
    GetTranslation: async (_ctx: Context, key: string): Promise<string> => key,
    AIChatStream: async (_ctx: Context, model: AI.AIModel, conversations: AI.Conversation[], options: AI.ChatOptions, callback: AI.ChatStreamFunc): Promise<void> => {
      streams.push({ model, conversations, options })
      if (stream) {
        stream(callback)
      }
    },
    GetUpdatableResult: async (_ctx: Context, id: string): Promise<UpdatableResult | null> => ({ Id: id }),
    UpdateResult: async (_ctx: Context, result: UpdatableResult): Promise<boolean> => {
      updated.push(result)
      return true
    },
    PushResults: async (_ctx: Context, _query: Query, results: Result[]): Promise<boolean> => {
      pushed.push(results)
      return true
    }
  }
  return { api: api as unknown as PublicAPI, updated, pushed, streams }
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

async function initPlugin(mock: MockApi): Promise<void> {
  await plugin.init({} as Context, { PluginDirectory: "", API: mock.api })
}

/** Let the fire-and-forget stream callbacks and their awaits finish. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe("AI matching", () => {
  test("stays off when the setting is disabled", async () => {
    const mock = makeApi({ aiEnabled: "false", aiModel: MODEL_JSON })
    await initPlugin(mock)

    const results = (await plugin.query({} as Context, makeQuery("happy"))) as Result[]

    expect(results.some(result => result.Id?.startsWith("ai-placeholder:"))).toBe(false)
    expect(mock.streams).toHaveLength(0)
  })

  test("adds a placeholder and streams with the selected model", async () => {
    const answer = JSON.stringify({
      items: [
        { text: "(ai_test_1)", category: "happy" },
        { text: "(ai_test_2)", category: "happy" }
      ]
    })
    const mock = makeApi({ aiEnabled: "true", aiModel: MODEL_JSON }, callback => {
      callback({ Status: "streaming", Data: '{"items":[', Reasoning: "", ToolCalls: [] })
      callback({ Status: "finished", Data: answer, Reasoning: "", ToolCalls: [] })
    })
    await initPlugin(mock)

    const results = (await plugin.query({} as Context, makeQuery("happy"))) as Result[]
    const placeholder = results.find(result => result.Id === "ai-placeholder:test-query-1")

    expect(placeholder).toBeDefined()
    expect(placeholder?.Title).toBe("ai_matching")
    expect(placeholder?.Group).toBe("ai_group")
    expect(mock.streams).toHaveLength(1)
    expect(mock.streams[0].model).toEqual({ Name: "test-model", Provider: "openai", ProviderAlias: "work" })
    expect(mock.streams[0].options).toEqual({ ThinkingMode: "non_thinking" })

    await flush()

    expect(mock.updated).toHaveLength(1)
    expect(mock.updated[0].Title).toBe("(ai_test_1)")
    expect(mock.updated[0].SubTitle).toBe("happy")
    expect(mock.pushed.flat().map(result => result.Title)).toEqual(["(ai_test_2)"])
  })

  test("parses JSON wrapped in prose and code fences", async () => {
    const answer = 'Here you go:\n```json\n{"items":[{"text":"(ai_wrapped)","category":"smug"}]}\n```'
    const mock = makeApi({ aiEnabled: "true", aiModel: MODEL_JSON }, callback => {
      callback({ Status: "finished", Data: answer, Reasoning: "", ToolCalls: [] })
    })
    await initPlugin(mock)

    await plugin.query({} as Context, makeQuery("smug"))
    await flush()

    expect(mock.updated).toHaveLength(1)
    expect(mock.updated[0].Title).toBe("(ai_wrapped)")
    expect(mock.updated[0].SubTitle).toBe("smug")
  })

  test("falls back to catalog matches when the response is not JSON", async () => {
    const answer = "Try :) or maybe LOVE★⌒ヾ(^-'*) instead."
    const mock = makeApi({ aiEnabled: "true", aiModel: MODEL_JSON }, callback => {
      callback({ Status: "finished", Data: answer, Reasoning: "", ToolCalls: [] })
    })
    await initPlugin(mock)

    await plugin.query({} as Context, makeQuery("love"))
    await flush()

    expect(mock.updated).toHaveLength(1)
    expect(answer).toContain(mock.updated[0].Title)
  })

  test("shows the failure state when the stream reports an error", async () => {
    const mock = makeApi({ aiEnabled: "true", aiModel: MODEL_JSON }, callback => {
      callback({ Status: "error", Data: "provider unavailable", Reasoning: "", ToolCalls: [] })
    })
    await initPlugin(mock)

    await plugin.query({} as Context, makeQuery("happy"))
    await flush()

    expect(mock.updated).toHaveLength(1)
    expect(mock.updated[0].Title).toBe("ai_failed")
    expect(mock.pushed).toHaveLength(0)
  })

  test("skips AI when no model is selected", async () => {
    const mock = makeApi({ aiEnabled: "true", aiModel: "" })
    await initPlugin(mock)

    const results = (await plugin.query({} as Context, makeQuery("happy"))) as Result[]

    expect(results.some(result => result.Id?.startsWith("ai-placeholder:"))).toBe(false)
    expect(mock.streams).toHaveLength(0)
  })

  test("skips AI when the host does not expose AIChatStream", async () => {
    const mock = makeApi({ aiEnabled: "true", aiModel: MODEL_JSON })
    delete (mock.api as unknown as { AIChatStream?: unknown }).AIChatStream
    await initPlugin(mock)

    const results = (await plugin.query({} as Context, makeQuery("happy"))) as Result[]

    expect(results.some(result => result.Id?.startsWith("ai-placeholder:"))).toBe(false)
    expect(mock.streams).toHaveLength(0)
  })

  test("restores AI-generated kaomoji from MRU context data", async () => {
    const mock = makeApi({ aiEnabled: "false", aiModel: "" })
    let restore: ((ctx: Context, data: MRUData) => Promise<Result | null>) | undefined
    mock.api.OnMRURestore = async (_ctx, callback) => {
      restore = callback
    }
    await initPlugin(mock)

    const result = await restore?.(
      {} as Context,
      {
        PluginID: "plugin",
        Title: "(ai_mru)",
        SubTitle: "happy",
        Icon: { ImageType: "relative", ImageData: "images/app.svg" },
        ContextData: { text: "(ai_mru)", category: "happy", source: "ai" }
      } as MRUData
    )

    expect(result?.Title).toBe("(ai_mru)")
    expect(result?.SubTitle).toBe("happy")
  })
})
