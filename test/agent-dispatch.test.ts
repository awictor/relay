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
    scrapePaged: async (url, maxPages) => { hits.push(`scrapePaged:${url}:${maxPages}`); return { title: "t", content: "--- page 1 ---\nA\n\n--- page 2 ---\nB", url, pages: 2, urls: [url, url + "?p=2"] }; },
    scrapeScroll: async (url, maxScrolls) => { hits.push(`scrapeScroll:${url}:${maxScrolls}`); return { title: "t", content: "item1 item2 item3 item4", url, scrolls: 3 }; },
    createSession: async () => { hits.push("createSession"); return { id: "s1" }; },
    navigate: async (_id, url) => { hits.push(`navigate:${url}`); return { url, title: "t" }; },
    click: async (_id, sel) => { hits.push(`click:${sel}`); },
    type: async (_id, sel) => { hits.push(`type:${sel}`); },
    readCurrent: async () => { hits.push("readCurrent"); return { title: "t", content: "text", url: "u" }; },
    releaseSession: async () => { hits.push("releaseSession"); },
    discoverLinks: async (url) => { hits.push(`discoverLinks:${url}`); return ["https://x.com/a"]; },
    fetchJson: async (url) => { hits.push(`fetchJson:${url}`); return { status: 200, contentType: "application/json", text: "{}" }; },
    screenshot: async (url, fullPage) => { hits.push(`screenshot:${url}${fullPage ? ":full" : ""}`); return new Uint8Array([1, 2, 3]); },
    pdf: async (url) => { hits.push(`pdf:${url}`); return new Uint8Array([4, 5, 6, 7]); },
  };
  return { b, hits };
}

describe("tool surface", () => {
  it("exposes exactly the expected tool names", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      ["browse", "calculate", "calendar_event", "click", "compare", "compose", "convert_currency", "convert_units", "date_math", "define", "directions", "encode_decode", "generate_password", "get_air_quality", "get_fact", "get_flight", "get_fun", "get_news", "get_nutrition", "where_to_watch", "get_scores", "get_suntimes", "get_time", "make_qr", "meal_ideas", "extract", "fetch_json", "find_nearby", "get_crypto", "get_quote", "get_weather", "pdf", "random", "recall", "save_page", "track_package", "read", "reply", "scrape", "scrape_pages", "scroll_feed", "screenshot", "search", "transcript", "translate", "type", "unit_price", "web_search", "extract_list"].sort()
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

  it("scrape_pages -> backend.scrapePaged with the page cap (multi-page-browse)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "scrape_pages", args: { url: "https://x.com/list", maxPages: 4 } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "got them" } } as ToolCall },
    ]);
    const r = await runAgent("the 20 newest listings on x", { llm, backend: b });
    expect(hits).toContain("scrapePaged:https://x.com/list:4");
    expect(r.tools).toContain("scrape_pages");
  });

  it("scrape_pages clamps maxPages into 1..5 and defaults to 3", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "scrape_pages", args: { url: "https://x.com/l1", maxPages: 99 } } as ToolCall },
      { toolCall: { name: "scrape_pages", args: { url: "https://x.com/l2" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "done" } } as ToolCall },
    ]);
    await runAgent("lots of results", { llm, backend: b });
    expect(hits).toContain("scrapePaged:https://x.com/l1:5"); // clamped down from 99
    expect(hits).toContain("scrapePaged:https://x.com/l2:3"); // default
  });

  it("scrape_pages with no backend.scrapePaged reports unavailable (falls back to scrape)", async () => {
    const { b } = recordingBackend();
    delete (b as { scrapePaged?: unknown }).scrapePaged;
    const llm = new ScriptLLM([
      { toolCall: { name: "scrape_pages", args: { url: "https://x.com/l" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "used scrape instead" } } as ToolCall },
    ]);
    const r = await runAgent("more results", { llm, backend: b });
    expect(r.reply).toBe("used scrape instead"); // no throw; model continues
  });

  it("scroll_feed -> backend.scrapeScroll, clamps maxScrolls 1..10, default 5 (browse-infinite-scroll)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "scroll_feed", args: { url: "https://x.com/feed", maxScrolls: 50 } } as ToolCall },
      { toolCall: { name: "scroll_feed", args: { url: "https://x.com/feed2" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "loaded the feed" } } as ToolCall },
    ]);
    const r = await runAgent("what's new on the feed", { llm, backend: b });
    expect(hits).toContain("scrapeScroll:https://x.com/feed:10"); // clamped from 50
    expect(hits).toContain("scrapeScroll:https://x.com/feed2:5"); // default
    expect(r.tools).toContain("scroll_feed");
  });

  it("scroll_feed with no backend.scrapeScroll reports unavailable (falls back to scrape)", async () => {
    const { b } = recordingBackend();
    delete (b as { scrapeScroll?: unknown }).scrapeScroll;
    const llm = new ScriptLLM([
      { toolCall: { name: "scroll_feed", args: { url: "https://x.com/feed" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "scrape fallback" } } as ToolCall },
    ]);
    const r = await runAgent("feed please", { llm, backend: b });
    expect(r.reply).toBe("scrape fallback");
  });

  it("extract_list gathers across pages then extracts rows as a JSON array (extract-across-pages)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "extract_list", args: { url: "https://x.com/list", fields: ["title", "price"], limit: 5, maxPages: 3 } } as ToolCall },
      // the extractor LLM step returns a JSON array of rows
      { text: '[{"title":"A","price":"$1"},{"title":"B","price":"$2"}]' },
      { toolCall: { name: "reply", args: { text: "found 2" } } as ToolCall },
    ]);
    const r = await runAgent("5 cheapest on x", { llm, backend: b });
    expect(hits).toContain("scrapePaged:https://x.com/list:3"); // gathered across pages
    expect(r.tools).toContain("extract_list");
    expect(r.reply).toBe("found 2");
  });

  it("extract_list falls back to scrolling when pagination finds only one page (extract-list-scroll-source)", async () => {
    const { b, hits } = recordingBackend();
    // pagination yields a single page (no next link) -> should try scrapeScroll to expand the feed
    b.scrapePaged = async (url) => { hits.push(`scrapePaged:${url}`); return { title: "t", content: "short", url, pages: 1, urls: [url] }; };
    const llm = new ScriptLLM([
      { toolCall: { name: "extract_list", args: { url: "https://x.com/feed", fields: ["title"], maxPages: 3 } } as ToolCall },
      { text: '[{"title":"a"},{"title":"b"},{"title":"c"}]' },
      { toolCall: { name: "reply", args: { text: "done" } } as ToolCall },
    ]);
    await runAgent("newest on the feed", { llm, backend: b });
    expect(hits).toContain("scrapePaged:https://x.com/feed"); // tried pagination first
    expect(hits).toContain("scrapeScroll:https://x.com/feed:5"); // fell back to scroll (pages===1)
  });

  it("extract_list does NOT scroll-fallback when pagination gathered multiple pages", async () => {
    const { b, hits } = recordingBackend(); // default scrapePaged returns pages:2
    const llm = new ScriptLLM([
      { toolCall: { name: "extract_list", args: { url: "https://x.com/list", fields: ["title"], maxPages: 3 } } as ToolCall },
      { text: '[{"title":"a"}]' },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("list", { llm, backend: b });
    expect(hits.some((h) => h.startsWith("scrapeScroll:"))).toBe(false); // multi-page -> no scroll needed
  });

  it("extract_list maxPages=1 uses a single scrape, not the pager", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "extract_list", args: { url: "https://x.com/one", fields: ["title"], maxPages: 1 } } as ToolCall },
      { text: '[{"title":"only"}]' },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("list from one page", { llm, backend: b });
    expect(hits).toContain("scrape:https://x.com/one");
    expect(hits.some((h) => h.startsWith("scrapePaged:https://x.com/one"))).toBe(false);
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

  it("web_search with zero results tells the model to broaden or admit it, not dead-end (empty-search-next-step)", async () => {
    const { b } = recordingBackend();
    b.webSearch = async () => []; // no results
    const llm = new ScriptLLM([
      { toolCall: { name: "web_search", args: { query: "asdfqwerzxcv nonexistent" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "I couldn't find anything on that." } } as ToolCall },
    ]);
    await runAgent("search that", { llm, backend: b });
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool")!.content;
    expect(toolMsg).toMatch(/No results/);
    expect(toolMsg).toMatch(/broader|different keywords|don't invent/i); // carries a next step, not a dead-end
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

  it("convert_currency with a non-numeric amount errors instead of silently converting 1 unit", async () => {
    // Regression: a model that passed amount as a word ("twenty") coerced to NaN, which the dispatch
    // silently treated as 1 -> a per-unit rate reported as if the user asked for it (wrong, no signal).
    const { b, hits } = recordingBackend();
    let called = false;
    b.convertCurrency = async (amt, from, to) => { called = true; hits.push(`fx:${amt}:${from}:${to}`); return { amount: amt, from, to, rate: 0.9, result: amt * 0.9 }; };
    const llm = new ScriptLLM([
      { toolCall: { name: "convert_currency", args: { amount: "twenty", from: "usd", to: "eur" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "I need a number." } } as ToolCall },
    ]);
    await runAgent("convert twenty usd to eur", { llm, backend: b });
    expect(called).toBe(false); // never dispatched the wrong 1-unit conversion
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool")!.content;
    expect(toolMsg).toMatch(/isn't a numeric amount/i);
  });

  it("convert_currency with a valid numeric amount dispatches to the backend", async () => {
    const { b, hits } = recordingBackend();
    b.convertCurrency = async (amt, from, to) => { hits.push(`fx:${amt}:${from}:${to}`); return { amount: amt, from, to, rate: 0.9, result: amt * 0.9 }; };
    const llm = new ScriptLLM([
      { toolCall: { name: "convert_currency", args: { amount: 20, from: "usd", to: "eur" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "€18." } } as ToolCall },
    ]);
    await runAgent("convert 20 usd to eur", { llm, backend: b });
    expect(hits).toContain("fx:20:usd:eur");
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

  it("generate_password produces a strong secret with no backend/network, reaches reply (password-generator)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "generate_password", args: { request: "generate a 20 character password" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Here's your password." } } as ToolCall },
    ]);
    await runAgent("make me a strong password", { llm, backend: b });
    // The tool result carries a real 20-char secret in a code span; no browser/network was touched.
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool")!.content;
    const secret = toolMsg.match(/`([^`]+)`/)?.[1] ?? "";
    expect(secret).toHaveLength(20);
    expect(toolMsg).toMatch(/EXACT/); // instructs the model not to alter the secret
    expect(hits.filter((h) => h.startsWith("scrape") || h.startsWith("fetchJson"))).toHaveLength(0);
  });

  it("encode_decode base64-round-trips with no backend/network, reaches reply (encode-decode-tool)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "encode_decode", args: { request: "base64 encode hello world" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Encoded it." } } as ToolCall },
    ]);
    await runAgent("base64 encode hello world", { llm, backend: b });
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool")!.content;
    expect(toolMsg).toContain("aGVsbG8gd29ybGQ="); // exact base64 of "hello world"
    expect(hits.filter((h) => h.startsWith("scrape") || h.startsWith("fetchJson"))).toHaveLength(0);
  });

  it("where_to_watch returns a JustWatch link with no backend call (movie-where-to-watch)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "where_to_watch", args: { title: "Dune Part Two" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Here's where to watch: <link>" } } as ToolCall },
    ]);
    const out = await runAgent("where can I watch Dune Part Two", { llm, backend: b });
    expect(hits.filter((h) => !h.startsWith("scrape") ? false : true)).toHaveLength(0); // no browser used
    expect(out.reply).toMatch(/watch/i);
  });

  it("save_page -> deps.savePage with the url/title/summary, no browser (agent-can-save-pages)", async () => {
    const { b, hits } = recordingBackend();
    const saves: Array<{ url: string; title?: string; summary?: string }> = [];
    const llm = new ScriptLLM([
      { toolCall: { name: "save_page", args: { url: "https://ex.com/pasta", title: "Best Carbonara", summary: "A simple 5-ingredient recipe." } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Saved it to your reading list." } } as ToolCall },
    ]);
    const out = await runAgent("find a good carbonara recipe and save it", {
      llm, backend: b,
      savePage: (url, title, summary) => { saves.push({ url, title, summary }); return { title: title ?? "x", saved: true }; },
    });
    expect(saves).toEqual([{ url: "https://ex.com/pasta", title: "Best Carbonara", summary: "A simple 5-ingredient recipe." }]);
    expect(hits.some((h) => h.startsWith("scrape"))).toBe(false); // pure store write, no browser
    expect(out.reply).toMatch(/saved/i);
  });

  it("save_page tells the model 'Updated' (not 'Saved') when the page was already in the list (save-page-confirm-dedupe-feedback)", async () => {
    const { b } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "save_page", args: { url: "https://ex.com/a", title: "A" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Updated it." } } as ToolCall },
    ]);
    await runAgent("save that again", { llm, backend: b, savePage: () => ({ title: "A", saved: true, dup: true }) });
    // The tool result fed back to the model on the 2nd call reflects the dup as "Updated", not "Saved".
    const secondCallMsgs = JSON.stringify(llm.calls[1]);
    expect(secondCallMsgs).toMatch(/Updated .*already in the reading list/);
    expect(secondCallMsgs).not.toMatch(/Saved .*to the user's reading list/);
  });

  it("save_page rejects a non-URL (never saves junk)", async () => {
    const { b } = recordingBackend();
    let called = false;
    const llm = new ScriptLLM([
      { toolCall: { name: "save_page", args: { url: "not a url" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "I couldn't save that — no valid link." } } as ToolCall },
    ]);
    const out = await runAgent("save that", { llm, backend: b, savePage: () => { called = true; return { title: "x", saved: true }; } });
    expect(called).toBe(false); // the invalid URL never reached the store
    expect(out.reply).toMatch(/couldn't save/i);
  });

  it("REFUSES a dangerous click at dispatch — the guard is wired, backend.click never runs (dangerous-action-runtime-gate-verify)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "browse", args: { url: "https://shop.example.com/cart" } } as ToolCall },
      { toolCall: { name: "click", args: { label: "Pay now", selector: "#pay" } } as ToolCall }, // committing action
      { toolCall: { name: "reply", args: { text: "I can't complete a payment for you." } } as ToolCall },
    ]);
    const out = await runAgent("check out my cart and pay", { llm, backend: b });
    expect(hits.some((h) => h.startsWith("click:"))).toBe(false); // guard fired BEFORE backend.click
    expect(out.reply).toMatch(/can't|won't|complete/i);
  });

  it("ALLOWS a benign click — the guard doesn't over-block navigation (dangerous-action-runtime-gate-verify)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "browse", args: { url: "https://news.example.com" } } as ToolCall },
      { toolCall: { name: "click", args: { label: "Read more", selector: ".read-more" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "Opened the article." } } as ToolCall },
    ]);
    await runAgent("open the full article", { llm, backend: b });
    expect(hits).toContain("click:.read-more"); // a safe click DID reach the backend
  });

  it("REFUSES a dangerous action named only in the SELECTOR, not the label (guard sees label+selector)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "browse", args: { url: "https://x.example.com" } } as ToolCall },
      { toolCall: { name: "click", args: { selector: "#delete-account-btn" } } as ToolCall }, // no label, danger in selector
      { toolCall: { name: "reply", args: { text: "I won't delete your account." } } as ToolCall },
    ]);
    await runAgent("clean up my account", { llm, backend: b });
    expect(hits.some((h) => h.startsWith("click:"))).toBe(false);
  });

  it("get_nutrition -> backend.getNutrition, reaches reply, no browser (nutrition-lookup)", async () => {
    const { b, hits } = recordingBackend();
    b.getNutrition = async (food) => { hits.push(`getNutrition:${food}`); return { food: "Banana, raw", kcal: 89, proteinG: 1.1, carbG: 22.8, fatG: 0.3 }; };
    const llm = new ScriptLLM([
      { toolCall: { name: "get_nutrition", args: { food: "banana" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "A banana is ~89 kcal per 100g." } } as ToolCall },
    ]);
    const out = await runAgent("calories in a banana", { llm, backend: b });
    expect(hits).toContain("getNutrition:banana");
    expect(out.reply).toMatch(/89 kcal/);
  });

  it("get_nutrition miss -> the model is told to say 'not sure', not invent numbers", async () => {
    const { b } = recordingBackend();
    b.getNutrition = async () => null;
    const llm = new ScriptLLM([
      { toolCall: { name: "get_nutrition", args: { food: "asdfqwer" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "I'm not sure about that one." } } as ToolCall },
    ]);
    const out = await runAgent("calories in asdfqwer", { llm, backend: b });
    expect(out.reply).toMatch(/not sure/i);
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

  it("get_time handles a 'how long until' countdown from nowMs + tz, no backend (time-until-tool)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "get_time", args: { request: "how long until 5pm" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "2 hours." } } as ToolCall },
    ]);
    // now = 2026-09-03 15:00 UTC, tz=UTC -> 2h until 5pm
    await runAgent("how long until 5pm", { llm, backend: b, nowMs: Date.UTC(2026, 8, 3, 15, 0, 0), tzOffsetMin: 0 });
    const toolMsg = llm.calls[1]!.find((m) => m.role === "tool")!.content;
    expect(toolMsg).toMatch(/2 hours until 5:00 PM/);
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

  it("screenshot fullPage:true passes through to the backend (full-page-screenshot)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "screenshot", args: { url: "https://x.com/p", fullPage: true } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "full page" } } as ToolCall },
    ]);
    const r = await runAgent("screenshot the whole page x", { llm, backend: b });
    expect(hits).toContain("screenshot:https://x.com/p:full"); // fullPage threaded through
    expect(r.photo).toBeInstanceOf(Uint8Array);
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

// Multi-step flow invariants: state that must survive ACROSS tool calls in one run — session reuse (not
// a new browser per step), a single release, and the captured photo/doc surviving to the returned result
// even when the run ends WITHOUT a clean reply. These are user-facing guarantees (the right artifact
// actually reaches the user) that single-tool dispatch tests don't cover (probe-multistep-agent-flows).
describe("runAgent multi-step flows", () => {
  it("browse -> click -> read -> reply reuses ONE session and releases it once", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "browse", args: { url: "https://x.com" } } as ToolCall },
      { toolCall: { name: "click", args: { selector: "#next", label: "next" } } as ToolCall },
      { toolCall: { name: "read", args: {} } as ToolCall },
      { toolCall: { name: "reply", args: { text: "done" } } as ToolCall },
    ]);
    const out = await runAgent("navigate the page", { llm, backend: b });
    expect(hits.filter((h) => h === "createSession")).toHaveLength(1); // NOT one session per step
    expect(hits.filter((h) => h === "releaseSession")).toHaveLength(1); // released exactly once (finally)
    expect(hits).toEqual(["createSession", "navigate:https://x.com", "click:#next", "readCurrent", "releaseSession"]);
    expect(out.reply).toBe("done");
  });

  it("two browse calls in one run share the session (no per-navigate leak)", async () => {
    const { b, hits } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "browse", args: { url: "https://a.com" } } as ToolCall },
      { toolCall: { name: "browse", args: { url: "https://b.com" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "ok" } } as ToolCall },
    ]);
    await runAgent("open two", { llm, backend: b });
    expect(hits.filter((h) => h === "createSession")).toHaveLength(1);
    expect(hits.filter((h) => h === "releaseSession")).toHaveLength(1);
  });

  it("a captured screenshot is delivered even when the STEP BUDGET runs out before a reply", async () => {
    // The photo is set on the screenshot step; if the run then exhausts its budget with no reply, the
    // degraded fallback path must STILL return the photo — else the user's screenshot silently vanishes.
    const { b } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "screenshot", args: { url: "https://x.com" } } as ToolCall },
      { text: "best-effort answer" }, // budget-reached final completion (no reply tool call)
    ]);
    const out = await runAgent("screenshot it", { llm, backend: b, maxSteps: 1 });
    expect(out.photo).toBeInstanceOf(Uint8Array);
    expect(out.photo!.length).toBe(3);
    expect(out.degraded).toBe(true); // ran out of steps -> soft failure, but the artifact survived
  });

  it("screenshot + pdf + an empty reply delivers BOTH artifacts with a default caption", async () => {
    const { b } = recordingBackend();
    const llm = new ScriptLLM([
      { toolCall: { name: "screenshot", args: { url: "https://x.com" } } as ToolCall },
      { toolCall: { name: "pdf", args: { url: "https://x.com" } } as ToolCall },
      { toolCall: { name: "reply", args: { text: "" } } as ToolCall }, // empty caption -> "Done."
    ]);
    const out = await runAgent("shot and pdf", { llm, backend: b });
    expect(out.photo!.length).toBe(3);
    expect(out.doc!.length).toBe(4);
    expect(out.reply).toBe("Done.");
  });
});
