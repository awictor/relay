import { describe, it, expect } from "vitest";
import { inferUnitsFromPlace, resolveUnits } from "../src/lib/units.js";

describe("inferUnitsFromPlace", () => {
  it("returns imperial for the three imperial-using countries", () => {
    expect(inferUnitsFromPlace("Austin, Texas, United States")).toBe("imperial");
    expect(inferUnitsFromPlace("Miami, Florida, USA")).toBe("imperial");
    expect(inferUnitsFromPlace("Monrovia, Liberia")).toBe("imperial");
    expect(inferUnitsFromPlace("Yangon, Myanmar")).toBe("imperial");
    expect(inferUnitsFromPlace("Mandalay, Burma")).toBe("imperial");
  });
  it("returns metric for a recognizable non-imperial place (country tail present)", () => {
    expect(inferUnitsFromPlace("Paris, Île-de-France, France")).toBe("metric");
    expect(inferUnitsFromPlace("London, England, United Kingdom")).toBe("metric");
    expect(inferUnitsFromPlace("Tokyo, Japan")).toBe("metric");
    expect(inferUnitsFromPlace("Berlin, Germany")).toBe("metric");
  });
  it("returns null when there's no usable signal (empty or a bare single token)", () => {
    expect(inferUnitsFromPlace("")).toBeNull();
    expect(inferUnitsFromPlace(undefined)).toBeNull();
    expect(inferUnitsFromPlace("Springfield")).toBeNull(); // no comma/country -> keep default
  });
  it("does not misread a US city that merely contains a substring", () => {
    // "us" is matched as a whole word, so "Houston" (contains 'us') must NOT become imperial via that.
    // But "Houston, Texas, United States" IS imperial via the country tail.
    expect(inferUnitsFromPlace("Houston")).toBeNull();
    expect(inferUnitsFromPlace("Houston, Texas, United States")).toBe("imperial");
  });
});

describe("resolveUnits", () => {
  it("an explicit user preference always wins", () => {
    expect(resolveUnits("metric", "Austin, Texas, United States")).toBe("metric"); // US but user set metric
    expect(resolveUnits("imperial", "Paris, France")).toBe("imperial");
  });
  it("falls back to the inferred value when no user pref", () => {
    expect(resolveUnits(undefined, "Paris, France")).toBe("metric");
    expect(resolveUnits(undefined, "Dallas, Texas, USA")).toBe("imperial");
  });
  it("uses the fallback (default imperial) when neither pref nor a usable place exists", () => {
    expect(resolveUnits(undefined, undefined)).toBe("imperial");
    expect(resolveUnits(undefined, "Springfield")).toBe("imperial");
    expect(resolveUnits(undefined, undefined, "metric")).toBe("metric"); // explicit fallback honored
  });
});
