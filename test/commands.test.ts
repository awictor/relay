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

  it("passes normal messages through (null)", () => {
    expect(handleCommand("top HN story")).toBeNull();
    expect(handleCommand("what is /help useful for")).toBeNull(); // not a leading command
    expect(handleCommand("")).toBeNull();
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
        scheduleList: () => [],
        scheduleCancel: () => ({ removed: 0 }),
        recipeList: () => [],
        recipeForget: () => false,
        recipeResolve: () => null,
        alertList: () => [],
        alertForget: () => false,
        digestList: () => [],
        digestForget: () => false,
        isDigest: () => false,
        digestRun: async () => null,
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
