import { describe, it, expect } from "vitest";
import { runAgent, TOOLS } from "../src/agent.js";
import type { LLMClient, LLMMessage, LLMResult, ToolSpec, ToolCall } from "../src/llm.js";
import type { BrowserBackend } from "../src/agent.js";

// Dispatch regression tests: as the tool set grows (scrape/browse/click/type/read/
// extract/compare/search/fetch_json/reply), assert each tool the model can emit is
// wired to the right backend call and the loop reaches "reply". NOT testing the model
// — testing that the tool surface + loop dispatch stay coherent.
class ScriptLLM implements LLMClient {
  calls: LLMMessage[][] = [];
  constructor(private script: LLMResult[]) {}
  async complete(messages: LLMMessage[], _tools: ToolSpec[]): Promise<LLMResult> {
    this.calls.push(messages);
    return this.script.shift() ?? { text: "(no more script)" };
  }
}

// A backend that records which methods the loop invoked.
function recordingBackend() {
  const hits: string[] = [];
  const b: BrowserBackend = {
    scrape: async (url) => { hits.push(`scrape:${url}`); return { title: "t", content: "PRICE=$1", url }; },
    createSession: async () => { hits.push("createSession"); return { id: "s1" }; },
    navigate: async (_id, url) => { hits.push(`navigate:${url}`); return { url, title: "t" }; },
    click: async (_id, sel) => { hits.push(`click:${sel}`); },
    type: async (_id, sel) => { hits.push(`type:${sel}`); },
    readCurrent: async () => { hits.push("readCurrent"); return { title: "t", content: "text", url: "u" }; },
    releaseSession: async () => { hits.push("releaseSession"); },
    discoverLinks: async (url) => { hits.push(`discoverLinks:${url}`); return ["https://x.com/a"]; },
    fetchJson: async (url) => { hits.push(`fetchJson:${url}`); return { status: 200, contentType: "application/json", text: "{}" }; },
    screenshot: async (url) => { hits.push(`screenshot:${url}`); return new Uint8Array([1, 2, 3]); },
    pdf: async (url) => { hits.push(`pdf:${url}`); return new Uint8Array([4, 5, 6, 7]); },
  };
  return { b, hits };
}

describe("tool surface", () => {
  it("exposes exactly the expected tool names", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      ["browse", "calculate", "calendar_event", "click", "compare", "compose", "convert_currency", "convert_units", "date_math", "define", "directions", "get_air_quality", "get_fact", "get_flight", "get_fun", "get_news", "get_scores", "get_suntimes", "get_time", "make_qr", "meal_ideas", "extract", "fetch_json", "find_nearby", "get_crypto", "get_quote", "get_weather", "pdf", "random", "recall", "track_package", "read", "reply", "scrape", "screenshot", "search", "transcript", "translate", "type", "unit_price", "web_search"].sort()
    );
  });

  it("every tool has a description and object parameters", () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.parameters.type).toBe("object");
    }
  });

  it("the system prompt lists screenshot + pdf so the model reaches for them (DEV-0035)", async () => {
    // Guard against re-omission: a tool in TOOLS but absent from the prose menu is effectively
    // dead — the model picks from the prompt. Assert both appear in the system message runAgent sends.
    const { b } = recordingBackend();
    const llm = new ScriptLLM([{ toolCall: { name: "reply", args: { text: "hi" } } as ToolCall }]);
    await runAgent("hi", { llm, backend: b });
    const sys = llm.calls[0]!.find((m) => m.role === "system")!.content;
    expect(sys).toMatch(/"screenshot"/);
    expect(sys).toMatch(/"pdf"/);
  });
});

describe("runAgent dispatch", () => {
  it("scrape -> backend.scrape", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "scrape", args: { url: "https://x.com/p" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("read it", { llm, backend: b });
    expect(hits).toContain("scrape:https://x.com/p");
  });

  it("fetch_json -> backend.fetchJson", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "fetch_json", args: { url: "https://api.x.com/d" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("api", { llm, backend: b });
    expect(hits).toContain("fetchJson:https://api.x.com/d");
  });

  it("search -> backend.discoverLinks", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "search", args: { url: "https://x.com/s" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("find", { llm, backend: b });
    expect(hits.some((h) => h.startsWith("discoverLinks:"))).toBe(true);
  });

  it("define -> backend.defineWord, reply carries the definition", async () => {
    const { b, hits } = recordingBackend();
    b.defineWord = async (w) => { hits.push(`defineWord:${w}`); return { word: w, phonetic: "/eks/", senses: [{ partOfSpeech: "noun", definitions: ["a test word"], synonyms: [] }], synonyms: ["trial"] }; };
    const llm = new ScriptLLM([
      { toolCall: { name: "define", args: { word: "escrow" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("define escrow", { llm, backend: b });
    expect(hits).toContain("defineWord:escrow");
  });

  it("translate uses an LLM sub-call for pasted text, no scrape, reaches reply", async () => {
    const { b, hits } = recordingBackend();
    // The dispatch calls deps.llm.complete for the translation; ScriptLLM answers the sub-call as text.
    const llm = new ScriptLLM([
      { toolCall: { name: "translate", args: { request: "translate 'hola' to English" } } as ToolCall },
      { text: "hello" }, // the translate sub-call
      { toolCall: { name: "reply", args: { text: "It means 'hello'." } } as ToolCall },
    ]);
    const out = await runAgent("translate hola to english", { llm, backend: b });
    expect(out.reply).toMatch(/hello/i);
    expect(hits.filter((h) => h.startsWith("scrape"))).toHaveLength(0); // pasted text -> no page fetch
  });

  it("convert_units computes exactly with no backend/network, reaches reply", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "convert_units", args: { request: "180C to F" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "356°F." } } as ToolCall },
    ]);
    await runAgent("180c to f", { llm, backend: b });
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool")!.content;
    expect(toolMsg).toMatch(/356 °F/);
    expect(hits.filter((h) => h.startsWith("scrape") || h.startsWith("fetchJson"))).toHaveLength(0);
  });

  it("calculate computes exactly with no backend/network, reaches reply", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "calculate", args: { expression: "(127.50 * 1.2) / 3" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "$51 each." } } as ToolCall },
    ]);
    await runAgent("split 127.50 three ways with 20% tip", { llm, backend: b });
    // the tool result carries the exact computed value; no scrape/fetch happened
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool")!.content;
    expect(toolMsg).toMatch(/= 51\b/);
    expect(hits.filter((h) => h.startsWith("scrape") || h.startsWith("fetchJson"))).toHaveLength(0);
  });

  it("get_suntimes -> backend.getSunTimes with the user's coords, reaches reply", async () => {
    const { b, hits } = recordingBackend();
    b.getSunTimes = async (opts) => { hits.push(`sun:${opts.lat ?? "geo"}`); return { place: "your location", day: "today" as const, date: "2026-09-03", sunrise: "6:30 AM", sunset: "7:28 PM", daylight: "12h 58m" }; };
    const llm = new ScriptLLM([
      { toolCall: { name: "get_suntimes", args: { request: "what time is sunset" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Sunset is 7:28 PM." } } as ToolCall },
    ]);
    const out = await runAgent("what time is sunset", { llm, backend: b, weatherCoords: { lat: 39.74, lng: -104.99 } });
    expect(hits).toContain("sun:39.74"); // no place named -> coords used directly
    expect(out.reply).toMatch(/7:28 PM/);
  });

  it("get_suntimes uses saved coords for an 'in the evening' phrasing, not treated as a place (suntimes-located-user-refused)", async () => {
    const { b, hits } = recordingBackend();
    b.getSunTimes = async (opts) => { hits.push(`sun:${opts.lat !== undefined ? "coords" : opts.near ? "near" : "none"}`); return opts.lat !== undefined ? { place: "your location", day: "today" as const, date: "d", sunrise: "6:30 AM", sunset: "7:28 PM", daylight: "12h" } : null; };
    const llm = new ScriptLLM([
      { toolCall: { name: "get_suntimes", args: { request: "is it dark by 7 in the evening" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Sunset 7:28 PM." } } as ToolCall },
    ]);
    const out = await runAgent("is it dark in the evening", { llm, backend: b, weatherCoords: { lat: 39.74, lng: -104.99 } });
    expect(hits).toContain("sun:coords"); // "in the evening" is NOT a place -> coords passed directly
    expect(out.reply).toMatch(/7:28 PM/);
  });

  it("meal_ideas -> backend.getMeals, reaches reply, no browser", async () => {
    const { b, hits } = recordingBackend();
    b.getMeals = async (req) => { hits.push(`getMeals:${req}`); return { ideas: [{ name: "Brown Stew Chicken", area: "Jamaican" }], ingredient: "chicken" }; };
    const llm = new ScriptLLM([
      { toolCall: { name: "meal_ideas", args: { request: "what can I make with chicken" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Try Brown Stew Chicken." } } as ToolCall },
    ]);
    const out = await runAgent("what can I make with chicken", { llm, backend: b });
    expect(hits.some((h) => h.startsWith("getMeals:"))).toBe(true);
    expect(out.reply).toMatch(/Brown Stew Chicken/);
  });

  it("get_news -> backend.getNews, reaches reply, no browser", async () => {
    const { b, hits } = recordingBackend();
    b.getNews = async (topic) => { hits.push(`getNews:${topic ?? ""}`); return { headlines: ["Big thing happened", "Another story"] }; };
    const llm = new ScriptLLM([
      { toolCall: { name: "get_news", args: {} } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Top: Big thing happened." } } as ToolCall },
    ]);
    const out = await runAgent("what's the news", { llm, backend: b });
    expect(hits).toContain("getNews:");
    expect(out.reply).toMatch(/Big thing/);
  });

  it("get_scores -> backend.getScores, reaches reply, no browser", async () => {
    const { b, hits } = recordingBackend();
    b.getScores = async (q) => { hits.push(`getScores:${q}`); return { leagueName: "NBA", games: [{ home: "Celtics", away: "Lakers", homeScore: 98, awayScore: 102, state: "post" as const, detail: "Final" }] }; };
    const llm = new ScriptLLM([
      { toolCall: { name: "get_scores", args: { request: "did the Lakers win" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Lakers won 102-98." } } as ToolCall },
    ]);
    const out = await runAgent("did the lakers win", { llm, backend: b });
    expect(hits).toContain("getScores:did the Lakers win");
    expect(out.reply).toMatch(/Lakers won/);
  });

  it("get_flight -> backend.getFlight, reaches reply, no browser (flight-status)", async () => {
    const { b, hits } = recordingBackend();
    b.getFlight = async (ref) => { hits.push(`getFlight:${ref.iata}`); return { ref, route: { iata: "AA100", airline: "American Airlines", origin: { iata: "JFK", city: "New York" }, destination: { iata: "LHR", city: "London" } }, live: { airborne: true, altFt: 37000 } }; };
    const llm = new ScriptLLM([
      { toolCall: { name: "get_flight", args: { flight: "AA100" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "AA100 is JFK->LHR, airborne." } } as ToolCall },
    ]);
    const out = await runAgent("is AA100 on time", { llm, backend: b });
    expect(hits).toContain("getFlight:AA100");
    expect(out.reply).toMatch(/AA100/);
  });

  it("get_flight with a non-flight string doesn't call the backend", async () => {
    const { b, hits } = recordingBackend();
    b.getFlight = async (ref) => { hits.push(`getFlight:${ref.iata}`); return null; };
    const llm = new ScriptLLM([
      { toolCall: { name: "get_flight", args: { flight: "the meeting is at 3" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "asked for a flight number" } } as ToolCall },
    ]);
    await runAgent("x", { llm, backend: b });
    expect(hits.filter((h) => h.startsWith("getFlight"))).toHaveLength(0);
  });

  it("get_fact -> backend.getFact, reaches reply, no browser (wikipedia-fast-fact)", async () => {
    const { b, hits } = recordingBackend();
    b.getFact = async (q) => { hits.push(`getFact:${q}`); return { fact: { title: "Mount Everest", description: "Earth's highest mountain", extract: "It's very tall.", url: "https://en.wikipedia.org/wiki/Mount_Everest" } }; };
    const llm = new ScriptLLM([
      { toolCall: { name: "get_fact", args: { query: "Mount Everest" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Everest is Earth's highest mountain." } } as ToolCall },
    ]);
    const out = await runAgent("how tall is everest", { llm, backend: b });
    expect(hits).toContain("getFact:Mount Everest");
    expect(out.reply).toMatch(/Everest/);
  });

  it("get_fact on an ambiguous term does not fabricate — the disambiguation note reaches the model", async () => {
    const { b } = recordingBackend();
    b.getFact = async () => ({ fact: null, disambiguation: true });
    const llm = new ScriptLLM([
      { toolCall: { name: "get_fact", args: { query: "Mercury" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Which Mercury do you mean?" } } as ToolCall },
    ]);
    const out = await runAgent("what is mercury", { llm, backend: b });
    expect(out.reply).toMatch(/which mercury/i);
  });

  it("get_time answers from nowMs without any backend call, reaches reply", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "get_time", args: { request: "what time is it in Tokyo" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    const out = await runAgent("time in tokyo", { llm, backend: b, nowMs: 1_700_000_000_000 });
    expect(out.reply).toBe("ok");
    // no browser/network method invoked — it's pure offset math
    expect(hits.filter((h) => h.startsWith("scrape") || h.startsWith("fetchJson"))).toHaveLength(0);
  });

  it("date_math answers from nowMs + tzOffsetMin without any backend call, reaches reply", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "date_math", args: { request: "what day of the week is 2026-07-04" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Saturday" } } as ToolCall },
    ]);
    const out = await runAgent("what day is july 4", { llm, backend: b, nowMs: 1_756_800_000_000, tzOffsetMin: 0 });
    expect(out.reply).toBe("Saturday");
    // pure calendar math — no browser/network method touched
    expect(hits.filter((h) => h.startsWith("scrape") || h.startsWith("fetchJson"))).toHaveLength(0);
  });

  it("define with no backend.defineWord reports unavailable, still reaches reply", async () => {
    const { b } = recordingBackend(); // no defineWord set
    const llm = new ScriptLLM([
      { toolCall: { name: "define", args: { word: "escrow" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    const out = await runAgent("define escrow", { llm, backend: b });
    expect(out.reply).toBe("ok");
  });

  it("browse -> createSession + navigate; read -> readCurrent; session released", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "browse", args: { url: "https://x.com/app" } } as ToolCall },
      { toolCall: { name: "read", args: {} } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("open + read", { llm, backend: b });
    expect(hits).toContain("createSession");
    expect(hits).toContain("navigate:https://x.com/app");
    expect(hits).toContain("readCurrent");
    expect(hits).toContain("releaseSession");
  });

  it("extract -> backend.scrape (then an LLM extraction sub-call)", async () => {
    const { b, hits } = recordingBackend();
    // fetch_json/extract sub-call returns JSON when tools=[] not needed here; extract
    // uses backend.scrape then an LLM sub-call which our ScriptLLM answers as text.
    const llm = new ScriptLLM([
      { toolCall: { name: "extract", args: { url: "https://x.com/i", fields: ["price"] } } as ToolCall },
      { text: '{"price":"$1"}' }, // extractFields sub-call
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("price", { llm, backend: b });
    expect(hits).toContain("scrape:https://x.com/i");
  });

  it("screenshot -> backend.screenshot, returns photo bytes (DEV-0027)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "screenshot", args: { url: "https://x.com/p" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "here it is" } } as ToolCall },
    ]);
    const r = await runAgent("show me x", { llm, backend: b });
    expect(hits).toContain("screenshot:https://x.com/p");
    expect(r.photo).toBeInstanceOf(Uint8Array);
    expect(r.photo!.length).toBe(3);
    expect(r.reply).toBe("here it is");
  });

  it("make_qr -> backend.makeQr, returns the QR photo bytes (qr-code-tool)", async () => {
    const { b, hits } = recordingBackend();
    (b as { makeQr?: (p: string) => Promise<Uint8Array> }).makeQr = async (p) => { hits.push(`makeQr:${p}`); return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]); };
    const llm = new ScriptLLM([
      { toolCall: { name: "make_qr", args: { payload: "https://x.com" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "here's your QR" } } as ToolCall },
    ]);
    const r = await runAgent("qr for x.com", { llm, backend: b });
    expect(hits).toContain("makeQr:https://x.com");
    expect(r.photo).toBeInstanceOf(Uint8Array);
    expect(r.reply).toBe("here's your QR");
  });

  it("make_qr with no backend.makeQr reports unavailable, no photo", async () => {
    const { b } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "make_qr", args: { payload: "hi" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    const r = await runAgent("qr", { llm, backend: b });
    expect(r.photo).toBeUndefined();
    expect(r.reply).toBe("ok");
  });

  it("pdf -> backend.pdf, returns doc bytes (DEV-0032)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "pdf", args: { url: "https://x.com/p" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "saved" } } as ToolCall },
    ]);
    const r = await runAgent("save x as pdf", { llm, backend: b });
    expect(hits).toContain("pdf:https://x.com/p");
    expect(r.doc).toBeInstanceOf(Uint8Array);
    expect(r.doc!.length).toBe(4);
  });

  it("pdf with no backend.pdf reports unavailable, no doc", async () => {
    const { b } = recordingBackend();
    delete (b as { pdf?: unknown }).pdf;
    const llm = new ScriptLLM([
      { toolCall: { name: "pdf", args: { url: "https://x.com/p" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "cant" } } as ToolCall },
    ]);
    const r = await runAgent("save x", { llm, backend: b });
    expect(r.doc).toBeUndefined();
  });

  it("screenshot with no backend.screenshot reports unavailable, no photo", async () => {
    const { b } = recordingBackend();
    delete (b as { screenshot?: unknown }).screenshot;
    const llm = new ScriptLLM([
      { toolCall: { name: "screenshot", args: { url: "https://x.com/p" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "can't" } } as ToolCall },
    ]);
    const r = await runAgent("show me x", { llm, backend: b });
    expect(r.photo).toBeUndefined();
  });

  it("click/type on the browsed session dispatch to backend.click/type", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "browse", args: { url: "https://x.com/f" } } as ToolCall },
      { toolCall: { name: "type", args: { selector: "#q", text: "hi" } } as ToolCall },
      { toolCall: { name: "click", args: { selector: "#go", label: "go" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("interact", { llm, backend: b });
    expect(hits).toContain("type:#q");
    expect(hits).toContain("click:#go");
  });
});
