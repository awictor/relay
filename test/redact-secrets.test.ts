import { describe, it, expect } from "vitest";
import {
  SENSITIVE_KEY_RE,
  redactSecretsDeep,
  redactBodyString,
} from "../src/lib/redact-secrets.js";

// DEV-0051: redact-secrets is a security primitive (stops tokens/passwords leaking into turn logs
// and bot replies), copied identical from DataFaucet so fixes merge back — but had only incidental
// coverage. These pin the redaction contract: match by KEY NAME at any depth, leave everything else
// byte-identical.

const REDACT = () => "[REDACTED]";

describe("SENSITIVE_KEY_RE", () => {
  it("matches the documented sensitive key names (case-insensitive)", () => {
    for (const k of [
      "password", "passwd", "secret", "token", "api_key", "apiKey", "access_token",
      "refresh_token", "private_key", "client_secret", "credential", "credit_card",
      "card_number", "cvv", "ssn", "social_security", "authorization", "Bearer",
      "auth", "x_auth", "API_KEY",
    ]) {
      expect(SENSITIVE_KEY_RE.test(k), `expected ${k} to match`).toBe(true);
    }
  });

  it("does NOT match ordinary keys", () => {
    for (const k of ["name", "email", "url", "count", "author_name", "description", "id"]) {
      expect(SENSITIVE_KEY_RE.test(k), `expected ${k} NOT to match`).toBe(false);
    }
  });

  it("is stateless across calls (no lingering /g lastIndex)", () => {
    // Guards against a future edit adding the /g flag, which would make .test() alternate.
    expect(SENSITIVE_KEY_RE.test("token")).toBe(true);
    expect(SENSITIVE_KEY_RE.test("token")).toBe(true);
  });
});

describe("redactSecretsDeep", () => {
  it("replaces a sensitive-keyed value at the top level", () => {
    const out = redactSecretsDeep({ token: "abc", name: "keep" }, REDACT) as Record<string, unknown>;
    expect(out.token).toBe("[REDACTED]");
    expect(out.name).toBe("keep");
  });

  it("replaces sensitive values at any nesting depth", () => {
    const out = redactSecretsDeep(
      { user: { profile: { password: "hunter2", handle: "alex" } } },
      REDACT,
    ) as any;
    expect(out.user.profile.password).toBe("[REDACTED]");
    expect(out.user.profile.handle).toBe("alex");
  });

  it("recurses through arrays", () => {
    const out = redactSecretsDeep(
      { items: [{ api_key: "k1" }, { api_key: "k2", label: "ok" }] },
      REDACT,
    ) as any;
    expect(out.items[0].api_key).toBe("[REDACTED]");
    expect(out.items[1].api_key).toBe("[REDACTED]");
    expect(out.items[1].label).toBe("ok");
  });

  it("passes primitives and null through untouched", () => {
    expect(redactSecretsDeep("plain", REDACT)).toBe("plain");
    expect(redactSecretsDeep(42, REDACT)).toBe(42);
    expect(redactSecretsDeep(null, REDACT)).toBeNull();
  });

  it("redacts the value regardless of what it holds (nested secret subtree is not recursed)", () => {
    // A sensitive KEY short-circuits: its whole value is replaced, not descended into.
    const out = redactSecretsDeep({ authorization: { scheme: "Bearer", raw: "xyz" } }, REDACT) as any;
    expect(out.authorization).toBe("[REDACTED]");
  });

  it("honors a custom keyRe when supplied", () => {
    const out = redactSecretsDeep({ nickname: "x", name: "y" }, REDACT, /nickname/i) as any;
    expect(out.nickname).toBe("[REDACTED]");
    expect(out.name).toBe("y");
  });
});

describe("redactBodyString", () => {
  const R = () => "[REDACTED]";

  it("redacts sensitive fields in a JSON body and re-serializes", () => {
    const out = redactBodyString(JSON.stringify({ token: "abc", keep: 1 }), R);
    const parsed = JSON.parse(out!);
    expect(parsed.token).toBe("[REDACTED]");
    expect(parsed.keep).toBe(1);
  });

  it("redacts sensitive fields in a urlencoded body", () => {
    const out = redactBodyString("token=abc&name=alex", R);
    expect(out).toBe("token=[REDACTED]&name=alex");
  });

  it("returns the original string when it is neither JSON nor urlencoded", () => {
    expect(redactBodyString("just some text", R)).toBe("just some text");
  });

  it("returns undefined for undefined/empty input", () => {
    expect(redactBodyString(undefined, R)).toBeUndefined();
    expect(redactBodyString("", R)).toBeUndefined();
  });
});
