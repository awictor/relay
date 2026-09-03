import { describe, it, expect } from "vitest";
import { TEMPLATES, getTemplate, templateCatalog, templateButtons } from "../src/lib/templates.js";

describe("templates (starter-template-library)", () => {
  it("every template has a unique id + a non-empty task and recipe name", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEMPLATES) {
      expect(t.task.length).toBeGreaterThan(0);
      expect(t.recipeName).toMatch(/^[a-z0-9 _-]+$/);
    }
  });
  it("getTemplate is case-insensitive; null for unknown", () => {
    expect(getTemplate("MORNING")!.recipeName).toBe("morning");
    expect(getTemplate("price")!.task).toMatch(/\{item\}/);
    expect(getTemplate("nope")).toBeNull();
  });
  it("templateCatalog lists each id", () => {
    const cat = templateCatalog();
    for (const t of TEMPLATES) expect(cat).toContain(`• ${t.id} —`);
  });
  it("every template has a tap-button label + templateButtons pairs id->label (starter-automation-gallery)", () => {
    for (const t of TEMPLATES) expect(t.button.length).toBeGreaterThan(0);
    const btns = templateButtons();
    expect(btns).toHaveLength(TEMPLATES.length);
    expect(btns[0]).toEqual({ id: TEMPLATES[0]!.id, label: TEMPLATES[0]!.button });
  });
});
