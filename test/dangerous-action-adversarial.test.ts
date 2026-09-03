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
  // dangerous-action-false-refuse: benign navigation that the OLD bare-noun list false-refused —
  // these dead-ended legit multi-step browses (order-tracking, filtered search, travel nav).
  ["Order status", "order-status is a read, not a purchase"],
  ["Track order", "tracking, not placing"],
  ["My orders", "order history nav"],
  ["Bookings", "a bookings list/tab"],
  ["Booking reference", "reading a reference"],
  ["reset filters", "clearing search filters"],
  [".remove-filter", "a filter-clear selector"],
  ["#send-search", "a search-submit selector, not sending money"],
  ["Remove filter", "clearing a filter"],
  ["Cancel", "a bare cancel/close-dialog button (no commit object)"],
  ["Close", "close a dialog/panel"],
  ["Send feedback", "not a money/message-commit the guard owns"],
  // dangerous-action-more-verbs: benign lookalikes of the new catches that must NOT trip.
  ["Apply filter", "apply + object, not apply now/for"],
  ["Apply coupon", "applying a coupon code, not committing"],
  ["Accept cookies", "a consent banner, not an agreement commit"],
  ["Sign in", "auth, not signing a document"],
  ["Sign up to read", "a signup gate, not a contract"],
  ["Register to read", "a nav/paywall gate"],
  ["See plan details", "reading plan info"],
  ["Compare plans", "comparing, not changing"],
  ["design plan", "'plan' as a noun in an unrelated phrase"],
  ["assign a task", "'sign' inside 'assign'"],
  ["Vote count", "reading a tally, not casting"],
  ["report card", "'report' as an unrelated noun"],
  ["update profile", "profile edit, not a commit object"],
];

// Ambiguous VERB + committing OBJECT — genuinely dangerous collocations that MUST still catch.
const MUST_CATCH_CONTEXTUAL: Array<[string, string]> = [
  ["Cancel my subscription", "cancel + subscription"],
  ["Cancel order", "cancel + order"],
  ["Remove payment card", "remove + payment/card"],
  ["Send money", "send + money"],
  ["Reset password", "password reset is destructive"],
  ["Factory reset", "factory reset"],
  ["Confirm order", "confirm + order"],
  ["Confirm and pay", "confirm + pay"],
  ["Book now", "reservation commitment"],
  // dangerous-action-more-verbs: commitment/publish/moderation/billing clicks the agent must not do.
  ["Apply now", "job/loan application commit"],
  ["Apply for this job", "application commit"],
  ["Accept offer", "accepting an offer is a commit"],
  ["Agree and continue", "agreeing to terms"],
  ["Accept terms", "accept + terms"],
  ["Enroll now", "enrollment commit"],
  ["Register now", "registration commit (not 'register to read')"],
  ["Reserve now", "reservation commit"],
  ["Rent now", "rental commit"],
  ["Remove all", "bulk delete"],
  ["Delete everything", "bulk destroy"],
  ["Unfriend", "social action on the user's behalf"],
  ["Block user", "moderation action"],
  ["Report as spam", "moderation report"],
  ["Flag as spam", "moderation flag"],
  ["Cash out", "money withdrawal"],
  ["Post comment", "publishing content"],
  ["Publish post", "publishing content"],
  ["Leave a review", "publishing a review"],
  ["Sign contract", "sign + contract"],
  ["sign the lease", "sign + lease"],
  ["Downgrade plan", "billing change"],
  ["Send $50 to John", "money by amount"],
  ["empty trash", "bulk destructive"],
];

describe("dangerous-action adversarial sweep (m26)", () => {
  for (const [label, why] of MUST_CATCH) {
    it(`catches "${label}" (${why})`, () => {
      expect(isDangerousAction(label), `${label} should be flagged dangerous`).toBe(true);
    });
  }
  for (const [label, why] of MUST_CATCH_CONTEXTUAL) {
    it(`catches contextual "${label}" (${why})`, () => {
      expect(isDangerousAction(label), `${label} should be flagged dangerous`).toBe(true);
    });
  }
  for (const [label, why] of MUST_ALLOW) {
    it(`allows "${label}" (${why})`, () => {
      expect(isDangerousAction(label), `${label} should be allowed`).toBe(false);
    });
  }
});
