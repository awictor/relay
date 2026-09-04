import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleCommand } from "../src/commands.js";
import { createHandler } from "../src/handler.js";
import type { InboundMessage } from "../src/telegram.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("handleCommand", () => {
  it("handles /start and /help (with bot suffix + case)", () => {
    expect(handleCommand("/start")).toMatch(/I'm Relay/);
    expect(handleCommand("/help")).toMatch(/what I can do/);
    expect(handleCommand("/HELP@relaybot")).toMatch(/what I can do/);
    expect(handleCommand("  /start extra args")).toMatch(/I'm Relay/);
  });

  it("/help mentions approve-to-act ONLY when the flag is on, default OFF (confirm-to-act-help-doc)", () => {
    const prev = process.env.RELAY_CONFIRM_TO_ACT;
    try {
      delete process.env.RELAY_CONFIRM_TO_ACT;
      expect(handleCommand("/help")).not.toMatch(/[Aa]pprove-to-act/); // default OFF -> absent
      expect(handleCommand("help")).not.toMatch(/[Aa]pprove-to-act/);  // bare word too
      process.env.RELAY_CONFIRM_TO_ACT = "1";
      const on = handleCommand("/help")!;
      expect(on).toMatch(/Approve-to-act/);          // flag on -> line present
      expect(on).toMatch(/tap ✅ Yes/);              // names the approval gesture
      expect(on).toMatch(/what I can do/);           // still the full HELP body
      expect(handleCommand("help")).toMatch(/Approve-to-act/); // bare word gets it too
    } finally {
      if (prev === undefined) delete process.env.RELAY_CONFIRM_TO_ACT;
      else process.env.RELAY_CONFIRM_TO_ACT = prev;
    }
  });

  it("/start leads with everyday errands + the 'just ask' framing, not a scraper pitch (onboarding-copy-life-assistant)", () => {
    const start = handleCommand("/start")!;
    // The plain-English framing appears before any power/scraper example.
    expect(start).toMatch(/just ask/i);
    // Everyday errands are advertised (weather / tip / reminder), not only HN/extract/screenshot.
    expect(start.toLowerCase()).toMatch(/weather/);
    expect(start.toLowerCase()).toMatch(/remind me/);
    // The location unlock is surfaced in onboarding (not buried in /help).
    expect(start.toLowerCase()).toMatch(/location/);
  });

  it("passes normal messages through (null)", () => {
    expect(handleCommand("top HN story")).toBeNull();
    expect(handleCommand("what is /help useful for")).toBeNull(); // not a leading command
    expect(handleCommand("")).toBeNull();
  });

  it("bare 'help'/'menu'/'commands'/'?' (no slash) returns the help text (command-intent-recovery)", () => {
    expect(handleCommand("help")).toMatch(/what I can do/);
    expect(handleCommand("menu")).toMatch(/what I can do/);
    expect(handleCommand("commands")).toMatch(/what I can do/);
    expect(handleCommand("?")).toMatch(/what I can do/);
    expect(handleCommand("/menu")).toMatch(/what I can do/);
    expect(handleCommand("help me plan a trip")).toBeNull(); // real task, not a help request
  });

  it("greets a new user's bare greeting / capability question with the intro (greeting-onboarding)", () => {
    expect(handleCommand("hi")).toMatch(/I'm Relay/);
    expect(handleCommand("Hey!")).toMatch(/I'm Relay/);
    expect(handleCommand("hello there")).toMatch(/I'm Relay/);
    expect(handleCommand("what can you do?")).toMatch(/I'm Relay/);
    expect(handleCommand("what do you do")).toMatch(/I'm Relay/);
    expect(handleCommand("get started")).toMatch(/I'm Relay/);
  });

  it("catches the phrasings people actually open with (widened CAPABILITY_RE)", () => {
    expect(handleCommand("what's this?")).toMatch(/I'm Relay/);
    expect(handleCommand("what is this")).toMatch(/I'm Relay/);
    expect(handleCommand("what does this do?")).toMatch(/I'm Relay/);
    expect(handleCommand("what's this bot")).toMatch(/I'm Relay/);
    expect(handleCommand("who are you")).toMatch(/I'm Relay/);
    expect(handleCommand("who r u")).toMatch(/I'm Relay/);
    expect(handleCommand("how do you work?")).toMatch(/I'm Relay/);
  });

  it("does NOT hijack a real task that merely starts like a greeting/question", () => {
    expect(handleCommand("hi, book me a table at Nobu tonight")).toBeNull(); // too long + real task
    expect(handleCommand("say hi to Sam on the forum")).toBeNull();
    expect(handleCommand("what can you tell me about the new iPhone")).toBeNull();
    expect(handleCommand("how do I reset my router")).toBeNull();
    expect(handleCommand("what does this error mean")).toBeNull();   // "this error", not this/it bot
    expect(handleCommand("who are you texting for the party")).toBeNull(); // real task, >6 words
    expect(handleCommand("how does this recipe work in the oven")).toBeNull(); // "this recipe", a real q
  });

  it("answers meta/trust questions with the honest fixed reply (meta-trust-canned-answers)", () => {
    expect(handleCommand("is this free?")).toMatch(/free to use/i);
    expect(handleCommand("are you a bot")).toMatch(/AI bot/i);
    expect(handleCommand("do you save my messages?")).toMatch(/rolling memory/i);
    expect(handleCommand("who made you")).toMatch(/free to use/i);
    expect(handleCommand("is my data safe")).toMatch(/shared or sold/i);
  });
  it("answers cost / identity / app meta questions too (widened META_RE)", () => {
    expect(handleCommand("how much do you cost")).toMatch(/free to use/i);
    expect(handleCommand("how much is this")).toMatch(/free to use/i);
    expect(handleCommand("are you chatgpt")).toMatch(/AI bot/i);
    expect(handleCommand("are you claude")).toMatch(/AI bot/i);
    expect(handleCommand("do you have an app")).toMatch(/free to use/i);
    // a real cost errand still runs
    expect(handleCommand("how much does a tesla cost")).toBeNull();
    expect(handleCommand("how much is 100 usd in eur")).toBeNull();
  });
  it("routes an 'examples / what else' ask to the intro card (onboarding-examples)", () => {
    expect(handleCommand("examples")).toMatch(/I'm Relay/);
    expect(handleCommand("show me examples")).toMatch(/I'm Relay/);
    expect(handleCommand("give me an example")).toMatch(/I'm Relay/);
    expect(handleCommand("what else can you do")).toMatch(/I'm Relay/);
    expect(handleCommand("what should I ask you")).toMatch(/I'm Relay/);
    // a real "examples of X" errand is NOT hijacked
    expect(handleCommand("give me examples of python decorators")).toBeNull();
    expect(handleCommand("what should I ask my doctor about")).toBeNull();
  });
  it("answers a bare acknowledgment warmly instead of running a browse turn (onboarding-ack)", () => {
    expect(handleCommand("thanks")).toMatch(/Anytime/i);
    expect(handleCommand("thank you so much")).toMatch(/Anytime/i);
    expect(handleCommand("ok thanks")).toMatch(/Anytime/i);
    expect(handleCommand("cool")).toMatch(/Anytime/i);
    expect(handleCommand("that's cool")).toMatch(/Anytime/i);
    // "thanks" followed by a real task still runs
    expect(handleCommand("thanks now tell me the weather")).toBeNull();
    expect(handleCommand("cool places near me")).toBeNull();
  });
  it("answers a can't-do capability probe honestly + pivots (capability-probe-answers)", () => {
    expect(handleCommand("can you book a flight")).toMatch(/can't do that one/i);
    expect(handleCommand("can you send a text to my mom")).toMatch(/what I CAN do/i);
    expect(handleCommand("can you call the restaurant")).toMatch(/can't do that one/i);
    expect(handleCommand("can you buy this for me")).toMatch(/can't/i);
    expect(handleCommand("could you check my email")).toBeNull(); // "check" not a can't-do verb here -> agent
  });
  it("does NOT hijack a real errand it CAN do", () => {
    expect(handleCommand("can you find the cheapest flight to NYC")).toBeNull();
    expect(handleCommand("can you compare these two prices")).toBeNull();
  });

  it("answers a site-named capability probe with the public-pages/cookies reply (site-capability-probe)", () => {
    expect(handleCommand("do you work with Amazon")).toMatch(/public pages/i);
    expect(handleCommand("can you use Gmail?")).toMatch(/log into your accounts/i);
    expect(handleCommand("does this work on Twitter")).toMatch(/\/sites/);
  });
  it("does NOT hijack a real read errand naming a site + a task", () => {
    expect(handleCommand("read the top story on Hacker News and summarize it")).toBeNull(); // long, real task
    expect(handleCommand("can you read Reuters")).toBeNull();   // 'read' is a real errand, not a support probe
    expect(handleCommand("can you browse Amazon")).toBeNull();  // 'browse' too
  });

  it("does NOT hijack a real errand that looks meta-ish", () => {
    expect(handleCommand("is this article free to read: example.com/x")).toBeNull(); // real errand + long
    expect(handleCommand("do you save documents to a folder on that site")).toBeNull();
    expect(handleCommand("are you free right now")).toBeNull(); // availability ask, not a cost/trust question
    expect(handleCommand("are you free to grab me a coffee")).toBeNull();
  });

  // DEV-0043/0044: /help must advertise EVERY user-facing capability, or a shipped tool is hidden
  // from users (screenshot/pdf were missing). Guard sync: a new tool without a HELP line fails here.
  it("/help mentions every user-facing capability keyword", () => {
    const help = handleCommand("/help")!;
    for (const kw of [/read a page/i, /extract/i, /compare/i, /find/i, /screenshot/i, /pdf/i]) {
      expect(help, `HELP missing ${kw}`).toMatch(kw);
    }
  });

  // DEV-0101: /start advertises a `Commands: /help /start /reset ...` line. The keyword guard above
  // only checks prose; nothing proved each ADVERTISED command is actually HANDLED (vs silently
  // falling through to the agent — advertising a dead command). Drive createHandler with every
  // capability dep stubbed + a runAgentFn spy, feed each advertised slash token, and assert the
  // spy is never called (each short-circuits) and a reply goes out.
  it("every advertised slash command is handled without hitting the agent", async () => {
    const start = handleCommand("/start")!;
    const line = start.split("\n").find((l) => /^Commands:/i.test(l));
    expect(line, "/start has a `Commands:` line").toBeTruthy();
    const commands = (line!.match(/\/[a-z-]+/gi) ?? []).map((c) => c.toLowerCase());
    // Guard the guard: if HELP stops listing the known set, this test is worthless — pin a floor.
    expect(commands).toEqual(
      expect.arrayContaining(["/help", "/start", "/reset", "/status", "/schedules", "/cancel", "/recipes", "/run", "/forget", "/digests", "/alerts"]),
    );

    for (const cmd of commands) {
      let agentCalls = 0;
      const sent: string[] = [];
      const handle = createHandler({
        llm: {} as never,
        memoryGet: () => [],
        memorySet: () => {},
        memoryClear: () => {},
        sendMessage: async (_id, text) => { sent.push(text); },
        sendTyping: async () => {},
        handleCommand,
        checkRateLimit: () => ({ allowed: true }),
        redactText: (t) => t,
        hasModelKey: () => true,
        recordTurn: () => {},
        now: () => 0,
        // Every optional capability stubbed so its branch is reachable.
        statusLine: () => "status",
        sitesLine: () => "sites",
        setLocation: (_id, t) => (/^\/setlocation\b/i.test(t) ? { location: "Testville" } : null),
        profileView: () => "Home location is Testville",
        profileClear: () => ({ had: true, saved: true }),
        dashboardView: () => "dashboard",
        scheduleList: () => [],
        scheduleCancel: () => ({ removed: 0 }),
        recipeList: () => [],
        recipeForget: () => false,
        recipeResolve: () => null,
        recipeSaveNamed: (_id, name) => ({ ok: true, name }), // /templates install branch

        alertList: () => [],
        alertForget: () => false,
        digestList: () => [],
        digestForget: () => false,
        isDigest: () => false,
        digestRun: async () => null,
        contactList: () => [], // /contacts branch

        runAgentFn: async () => { agentCalls++; return { reply: "AGENT", steps: 1, tools: [] }; },
        log: () => {},
      });
      await handle({ chatId: 7, from: "u", text: cmd } as InboundMessage);
      expect(agentCalls, `${cmd} fell through to the agent instead of being handled`).toBe(0);
      expect(sent.length, `${cmd} produced no reply`).toBeGreaterThan(0);
    }
  });

  // DEV-0105: the INVERSE of the guard above found a live bug — /forget-digest was dispatched by the
  // handler (a first=== branch) but mentioned NOWHERE user-facing, so users couldn't discover it.
  // Every dispatched slash command must appear in the /help or /start text (minus pure aliases the
  // user never needs advertised, e.g. /clear is an alias of /reset).
  it("every handler-dispatched slash command is discoverable in /help or /start", () => {
    const handlerSrc = readFileSync(join(ROOT, "src", "handler.ts"), "utf8");
    const dispatched = new Set(
      (handlerSrc.match(/first === "(\/[a-z-]+)"/g) ?? []).map((m) => m.replace(/first === "|"/g, "")),
    );
    expect(dispatched.size, "scanner found the handler's first=== commands").toBeGreaterThan(5);

    const ALIASES = new Set(["/clear"]); // /clear is an alias of /reset; not advertised on purpose
    const discoverable = (handleCommand("/help")! + "\n" + handleCommand("/start")!).toLowerCase();
    const undiscoverable = [...dispatched].filter((c) => !ALIASES.has(c) && !discoverable.includes(c.toLowerCase()));
    expect(undiscoverable, `dispatched but undiscoverable (add to HELP/START): ${undiscoverable.join(", ")}`).toEqual([]);
  });
});
