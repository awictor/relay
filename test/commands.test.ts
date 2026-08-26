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
});
