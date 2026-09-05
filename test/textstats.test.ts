import { describe, it, expect } from "vitest";
import { wordCount, charCount, reverseText, isPalindrome, titleCase, slugify, parseTextStats, runTextStats } from "../src/lib/textstats.js";

describe("primitives", () => {
  it("wordCount", () => {
    expect(wordCount("the quick brown fox")).toBe(4);
    expect(wordCount("  spaced   out  ")).toBe(2);
    expect(wordCount("")).toBe(0);
  });
  it("charCount with/without spaces (code-point aware)", () => {
    expect(charCount("hello world")).toBe(11);
    expect(charCount("hello world", false)).toBe(10);
    expect(charCount("café")).toBe(4);
  });
  it("reverseText by code point", () => {
    expect(reverseText("hello")).toBe("olleh");
    expect(reverseText("abc")).toBe("cba");
  });
  it("isPalindrome ignores case + punctuation", () => {
    expect(isPalindrome("racecar")).toBe(true);
    expect(isPalindrome("A man, a plan, a canal: Panama")).toBe(true);
    expect(isPalindrome("hello")).toBe(false);
    expect(isPalindrome("")).toBe(false);
  });
});

describe("parseTextStats", () => {
  it("classifies + extracts the payload", () => {
    expect(parseTextStats("word count of the quick brown fox")).toEqual({ op: "words", text: "the quick brown fox" });
    expect(parseTextStats("how many characters in hello world")).toEqual({ op: "chars", text: "hello world" });
    expect(parseTextStats("reverse this: hello")).toEqual({ op: "reverse", text: "hello" });
    expect(parseTextStats("is racecar a palindrome")).toEqual({ op: "palindrome", text: "racecar" });
    // verb-first "count the words/characters" phrasing (previously fell through to null).
    expect(parseTextStats("count the words: one two three four five")).toEqual({ op: "words", text: "one two three four five" });
    expect(parseTextStats("count the characters in hello")).toEqual({ op: "chars", text: "hello" });
    expect(parseTextStats("count words: a b c")).toEqual({ op: "words", text: "a b c" });
    expect(parseTextStats("what's the weather")).toBeNull();
  });
});

describe("runTextStats", () => {
  it("formats each op", () => {
    expect(runTextStats("word count of the quick brown fox")).toMatch(/4 words/);
    expect(runTextStats("how many characters in hello world")).toMatch(/11 characters \(10 without spaces\)/);
    expect(runTextStats("reverse this: hello")).toMatch(/Reversed: olleh/);
    expect(runTextStats("is racecar a palindrome")).toMatch(/Yes/);
    expect(runTextStats("is hello a palindrome")).toMatch(/No/);
    expect(runTextStats("random chatter")).toBeNull();
  });
  it("case conversion ops (text-case-ops)", () => {
    expect(runTextStats("uppercase hello world")).toBe("HELLO WORLD");
    expect(runTextStats("make hello uppercase")).toBe("HELLO");
    expect(runTextStats("hello in caps")).toBe("HELLO");
    expect(runTextStats("lowercase HELLO")).toBe("hello");
    expect(runTextStats("title case the quick brown fox")).toBe("The Quick Brown Fox");
    expect(runTextStats("slugify My Blog Post!")).toBe("my-blog-post");
    expect(runTextStats("make a slug of Hello World")).toBe("hello-world");
  });
});

describe("titleCase / slugify primitives", () => {
  it("titleCase capitalizes each word, lowercasing the rest", () => {
    expect(titleCase("the QUICK brown")).toBe("The Quick Brown");
  });
  it("slugify lowercases, strips accents + punctuation, hyphenates", () => {
    expect(slugify("Café Déjà Vu!")).toBe("cafe-deja-vu");
    expect(slugify("  Multiple   Spaces  ")).toBe("multiple-spaces");
  });
});
