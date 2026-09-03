import { describe, it, expect } from "vitest";
import { isTextualDoc, decodeTextDoc, buildDocPrompt } from "../src/lib/docs.js";

describe("isTextualDoc", () => {
  it("treats csv/json/txt/markdown/xml/yaml + any text/* as textual", () => {
    expect(isTextualDoc("text/csv")).toBe(true);
    expect(isTextualDoc("application/json")).toBe(true);
    expect(isTextualDoc("text/plain")).toBe(true);
    expect(isTextualDoc("text/markdown")).toBe(true);
    expect(isTextualDoc("text/x-anything")).toBe(true); // text/* fallthrough
    expect(isTextualDoc("text/csv; charset=utf-8")).toBe(true); // param stripped
  });
  it("treats pdf + images as vision docs (NOT textual)", () => {
    expect(isTextualDoc("application/pdf")).toBe(false);
    expect(isTextualDoc("image/jpeg")).toBe(false);
    expect(isTextualDoc("image/png")).toBe(false);
  });
  it("falls back to the file extension when the mime is generic/absent", () => {
    expect(isTextualDoc("application/octet-stream", "statement.csv")).toBe(true);
    expect(isTextualDoc("", "notes.md")).toBe(true);
    expect(isTextualDoc("application/octet-stream", "scan.pdf")).toBe(false); // pdf mime rule doesn't hit; ext isn't textual
    expect(isTextualDoc("application/octet-stream", "photo.jpg")).toBe(false);
  });
});

describe("decodeTextDoc", () => {
  it("decodes utf-8 bytes and strips a BOM", () => {
    const bytes = new TextEncoder().encode("﻿name,amount\nrent,1200");
    const out = decodeTextDoc(bytes);
    expect(out.startsWith("name,amount")).toBe(true); // BOM gone
    expect(out).toContain("rent,1200");
  });
  it("caps very long docs with a visible truncation marker", () => {
    const big = "x".repeat(25_000);
    const out = decodeTextDoc(new TextEncoder().encode(big));
    expect(out.length).toBeLessThan(25_000);
    expect(out).toMatch(/document truncated at 20000 characters/);
  });
});

describe("buildDocPrompt", () => {
  it("uses the caption as the question and embeds the doc between markers", () => {
    const p = buildDocPrompt("a,b\n1,2", "what's the total of column b", "data.csv");
    expect(p).toContain("what's the total of column b");
    expect(p).toContain("(data.csv)");
    expect(p).toMatch(/--- DOCUMENT ---[\s\S]*a,b[\s\S]*--- END DOCUMENT ---/);
  });
  it("defaults the question when no caption is given", () => {
    const p = buildDocPrompt("x", "");
    expect(p).toMatch(/Summarize this document/);
  });
});
