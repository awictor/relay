import { describe, it, expect } from "vitest";
import { isDangerousAction } from "../src/safety.js";

// m26 safety-audit-2: adversarial sweep of the dangerous-action guard. The agent refuses clicks/types
// whose label matches this — the gate on autonomous state-changing actions. Each MUST be caught.
const MUST_CATCH: Array<[string, string]> = [
  // plain committing/destructive verbs
  ["Pay now", "pay"],
  ["Buy it now", "buy"],
  ["Complete purchase", "purchase"],
  ["Place order", "order"],
  ["Checkout", "checkout"],
  ["Submit", "submit"],
  ["Confirm order", "confirm"],
  ["Delete account", "delete"],
  ["Remove item", "remove"],
  ["Transfer funds", "transfer"],
  ["Withdraw", "withdraw"],
  ["Send money", "send"],
  ["Log out", "log out"],
  ["Sign out", "sign out"],
  ["Deactivate account", "deactivate"],
  ["Unsubscribe", "unsubscribe"],
  // casing / spacing variants
  ["PAY", "uppercase"],
  ["DeLeTe", "mixed case"],
  ["pay  now", "extra spaces"],
  // synonyms the agent could plausibly click (these test whether the list is broad enough)
  ["Subscribe", "subscribe (starts a paid commitment)"],
  ["Place bid", "bid"],
  ["Add to cart", "add to cart"],
  ["Book now", "book"],
  ["Donate", "donate"],
];

// These should NOT trip the guard (read-only navigation) — no over-blocking.
const MUST_ALLOW: Array<[string, string]> = [
  ["Read more", "read more"],
  ["Next page", "next"],
  ["Search results", "search"],
  ["View details", "view"],
  ["Show comments", "show"],
];

describe("dangerous-action adversarial sweep (m26)", () => {
  for (const [label, why] of MUST_CATCH) {
    it(`catches "${label}" (${why})`, () => {
      expect(isDangerousAction(label), `${label} should be flagged dangerous`).toBe(true);
    });
  }
  for (const [label, why] of MUST_ALLOW) {
    it(`allows "${label}" (${why})`, () => {
      expect(isDangerousAction(label), `${label} should be allowed`).toBe(false);
    });
  }
});
