import { describe, it, expect } from "vitest";
import { stripTrailingCourtesy } from "../src/lib/text-clean.js";

describe("stripTrailingCourtesy (courtesy-tail bug class)", () => {
  it("strips a trailing please/pls/plz/thanks + punctuation", () => {
    expect(stripTrailingCourtesy("call mom please")).toBe("call mom");
    expect(stripTrailingCourtesy("buy milk pls")).toBe("buy milk");
    expect(stripTrailingCourtesy("send the weather thanks")).toBe("send the weather");
    expect(stripTrailingCourtesy("do the thing, thank you")).toBe("do the thing");
    expect(stripTrailingCourtesy("convert to lbs please?")).toBe("convert to lbs");
  });
  it("onlyPlease keeps 'thanks' (it can be the value — 'say thanks')", () => {
    expect(stripTrailingCourtesy("say thanks", { onlyPlease: true })).toBe("say thanks");
    expect(stripTrailingCourtesy("call mom please", { onlyPlease: true })).toBe("call mom");
  });
  it("keeps a mid-value courtesy word + a bare-courtesy whole value", () => {
    expect(stripTrailingCourtesy("say please to grandma")).toBe("say please to grandma"); // mid, not trailing
    expect(stripTrailingCourtesy("please")).toBe("please");   // whole value -> keep (nothing else said)
    expect(stripTrailingCourtesy("thanks")).toBe("thanks");
  });
  it("leaves an ordinary value untouched", () => {
    expect(stripTrailingCourtesy("500 5th Ave")).toBe("500 5th Ave");
    expect(stripTrailingCourtesy("r/programming")).toBe("r/programming");
  });
});
