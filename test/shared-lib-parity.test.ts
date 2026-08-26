import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// m28 parity-2: guard the "copied-and-must-mirror" shared libs (SHARED.md §2) so a forgotten mirror
// fails CI instead of silently splitting SSRF/redaction behavior across Relay + DataFaucet — the
// exact drift the m26/m27 audit found. anvil-client uses a BYTE-identical parity test; these two
// can't (each repo's header comment legitimately differs — "Copied from mcp-forge" only makes sense
// in Relay). So we compare CODE only: strip comments + blank lines + collapse whitespace, then the
// executable text must match. Skips gracefully if ../mcp-forge isn't checked out (relay CI is
// self-contained; the mcp-forge-side mirror guards the other direction — parity-3).
const PAIRS = ["url-validator.ts", "redact-secrets.ts"];

/** Reduce a TS source to comparable code: drop // and block comments, blank lines, and normalize
 * whitespace runs. Deliberately conservative — it only needs to null out the doc-comment + spacing
 * differences that legitimately vary per repo, while any real logic change still shows up. */
function codeOnly(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1") // line comments (not matching :// in a URL)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .replace(/[ \t]+/g, " ");
}

describe("shared-lib parity: url-validator + redact-secrets (m28)", () => {
  for (const file of PAIRS) {
    const here = join(process.cwd(), "src", "lib", file);
    const there = join(process.cwd(), "..", "mcp-forge", "src", "lib", file);

    it(`${file}: relay copy exists`, () => {
      expect(existsSync(here)).toBe(true);
    });

    it(`${file}: code matches the mcp-forge copy (skips if mcp-forge absent)`, () => {
      if (!existsSync(there)) return; // relay CI runs alone — mcp-forge-side test covers this direction
      expect(codeOnly(readFileSync(there, "utf8"))).toBe(codeOnly(readFileSync(here, "utf8")));
    });
  }
});
