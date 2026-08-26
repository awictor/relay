import { describe, it, expect } from "vitest";
import { handleCommand } from "../src/commands.js";

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
});
