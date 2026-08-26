import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// DEV-0054/0055: keep .env.example in sync with the env vars the code actually reads. An operator
// running the 24/7 deploy discovers tunables from .env.example; a var read in src but absent there is
// an invisible config knob. This scans src for process.env.X and asserts each is documented (a
// commented `# NAME=` line counts as documented — optional-with-default is still discoverable).

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function envVarsReadInSrc(): Set<string> {
  const re = /process\.env\.([A-Z0-9_]+)/g;
  const found = new Set<string>();
  for (const f of walk(SRC)) {
    const text = readFileSync(f, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) found.add(m[1]!);
  }
  return found;
}

function documentedKeys(): Set<string> {
  const text = readFileSync(join(ROOT, ".env.example"), "utf8");
  const keys = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    // Accept both active `NAME=...` and commented `# NAME=...` lines.
    const m = raw.match(/^\s*#?\s*([A-Z0-9_]+)\s*=/);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

describe(".env.example parity (DEV-0055)", () => {
  it("documents every env var the code reads", () => {
    const read = envVarsReadInSrc();
    const documented = documentedKeys();
    const missing = [...read].filter((k) => !documented.has(k)).sort();
    expect(missing, `undocumented env vars in .env.example: ${missing.join(", ")}`).toEqual([]);
  });

  it("reads at least the known core vars (guards the scanner itself)", () => {
    const read = envVarsReadInSrc();
    for (const k of ["TELEGRAM_BOT_TOKEN", "GEMINI_API_KEY", "ANVIL_BASE_URL"]) {
      expect(read.has(k), `scanner should have found ${k}`).toBe(true);
    }
  });
});
