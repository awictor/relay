import { describe, it, expect } from "vitest";
import { rowsToCsv } from "../src/lib/to-csv.js";

describe("rowsToCsv (csv-export-compare)", () => {
  it("serializes rows with a union header, first-seen column order", () => {
    const rows = [
      { url: "a", price: 10, rating: 4.5 },
      { url: "b", price: 20, rating: 4.0 },
    ];
    expect(rowsToCsv(rows)).toBe("url,price,rating\r\na,10,4.5\r\nb,20,4");
  });
  it("unions keys across rows + leaves missing cells empty", () => {
    const rows = [{ a: 1 }, { a: 2, b: 3 }];
    expect(rowsToCsv(rows)).toBe("a,b\r\n1,\r\n2,3");
  });
  it("RFC-4180 escapes commas, quotes, newlines", () => {
    const rows = [{ name: "Acme, Inc", note: 'he said "hi"', bio: "line1\nline2" }];
    expect(rowsToCsv(rows)).toBe('name,note,bio\r\n"Acme, Inc","he said ""hi""","line1\nline2"');
  });
  it("null/undefined -> empty; objects -> compact JSON", () => {
    const rows = [{ a: null, b: undefined as unknown, c: { x: 1 } }];
    expect(rowsToCsv(rows)).toBe('a,b,c\r\n,,"{""x"":1}"');
  });
  it("neutralizes formula-injection cells (=, +, -, @) with a leading quote", () => {
    const rows = [{ a: "=HYPERLINK(\"http://evil\")", b: "+1+2", c: "-cmd", d: "@SUM(A1)", safe: "normal" }];
    const csv = rowsToCsv(rows);
    // Each risky cell is prefixed with ' so Excel/Sheets treats it as text, not a formula.
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+1+2");
    expect(csv).toContain("'-cmd");
    expect(csv).toContain("'@SUM(A1)");
    expect(csv).toContain("normal"); // a safe cell is untouched (no quote)
    expect(csv).not.toContain("'normal");
  });

  it("does NOT quote a legitimate negative number (stays sortable)", () => {
    const rows = [{ pnl: "-5.2", big: "-1,000.00", n: -3, formula: "-cmd|calc" }];
    const csv = rowsToCsv(rows);
    expect(csv).toContain("-5.2");      // negative number untouched (no leading quote)
    expect(csv).not.toContain("'-5.2");
    expect(csv).toContain("-3");
    expect(csv).toContain("'-cmd|calc"); // a non-numeric formula-lead still guarded
  });

  it("empty / invalid input -> empty string", () => {
    expect(rowsToCsv([])).toBe("");
    expect(rowsToCsv(null)).toBe("");
    expect(rowsToCsv([1, 2, 3])).toBe(""); // no object keys
  });
});
