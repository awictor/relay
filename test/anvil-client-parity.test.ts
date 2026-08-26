import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// m13 shared-3: mirror of the mcp-forge parity guard. src/lib/anvil-client.ts is the CANONICAL
// copy; it's vendored into mcp-forge (../mcp-forge/src/lib/anvil-client.ts). This asserts the two
// stay byte-identical (modulo line endings). Skips gracefully when mcp-forge isn't checked out
// beside relay (so relay CI stays self-contained). Vendoring contract: edit the canonical file
// here -> copy it to mcp-forge -> both parity tests pass.
describe("anvil-client vendoring parity (m13)", () => {
  const canonical = join(process.cwd(), "src", "lib", "anvil-client.ts");
  const vendored = join(process.cwd(), "..", "mcp-forge", "src", "lib", "anvil-client.ts");
  const norm = (s: string) => s.replace(/\r\n/g, "\n");

  it("has the canonical anvil-client", () => {
    expect(existsSync(canonical)).toBe(true);
  });

  it("the mcp-forge vendored copy is byte-identical (skips if mcp-forge absent)", () => {
    if (!existsSync(vendored)) return; // relay CI runs alone — the mcp-forge-side test covers it there
    expect(norm(readFileSync(vendored, "utf8"))).toBe(norm(readFileSync(canonical, "utf8")));
  });
});
