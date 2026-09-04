import { describe, it, expect } from "vitest";
import { parseEncodingRequest, runEncoding, formatEncoding } from "../src/lib/encoding.js";

describe("parseEncodingRequest", () => {
  it("parses encode asks with the codec + verbatim payload", () => {
    expect(parseEncodingRequest("base64 encode hello world")).toEqual({ op: "encode", codec: "base64", text: "hello world" });
    expect(parseEncodingRequest("url encode a b&c")).toEqual({ op: "encode", codec: "url", text: "a b&c" });
    expect(parseEncodingRequest("hex encode hi")).toEqual({ op: "encode", codec: "hex", text: "hi" });
    expect(parseEncodingRequest("base64url encode hi")).toEqual({ op: "encode", codec: "base64url", text: "hi" });
  });
  it("parses decode asks (colon-delimited payload preserved exactly)", () => {
    expect(parseEncodingRequest("decode this base64: aGVsbG8=")).toEqual({ op: "decode", codec: "base64", text: "aGVsbG8=" });
    expect(parseEncodingRequest("decode hex 6869")).toEqual({ op: "decode", codec: "hex", text: "6869" });
    expect(parseEncodingRequest("url decode a%20b")).toEqual({ op: "decode", codec: "url", text: "a%20b" });
  });
  it("parses a JWT decode (payload segment captured)", () => {
    const r = parseEncodingRequest("decode this jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig");
    expect(r).toEqual({ op: "decode", codec: "jwt", text: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig" });
  });
  it("returns null for non-encoding chatter", () => {
    expect(parseEncodingRequest("what's the weather")).toBeNull();
    expect(parseEncodingRequest("encode the situation for me")).not.toBeNull(); // has 'encode' -> treated as encode (payload "the situation for me"); acceptable
    expect(parseEncodingRequest("tell me a joke")).toBeNull();
  });
});

describe("runEncoding", () => {
  it("round-trips base64", () => {
    const enc = runEncoding({ op: "encode", codec: "base64", text: "hello world" });
    expect(enc).toBe("aGVsbG8gd29ybGQ=");
    expect(runEncoding({ op: "decode", codec: "base64", text: enc })).toBe("hello world");
  });
  it("handles multi-byte UTF-8 correctly (where a hand-computed encoding would fail)", () => {
    const enc = runEncoding({ op: "encode", codec: "base64", text: "café ☕" });
    expect(runEncoding({ op: "decode", codec: "base64", text: enc })).toBe("café ☕");
  });
  it("round-trips url + hex", () => {
    expect(runEncoding({ op: "encode", codec: "url", text: "a b&c=d" })).toBe("a%20b%26c%3Dd");
    expect(runEncoding({ op: "decode", codec: "url", text: "a%20b%26c%3Dd" })).toBe("a b&c=d");
    expect(runEncoding({ op: "encode", codec: "hex", text: "hi" })).toBe("6869");
    expect(runEncoding({ op: "decode", codec: "hex", text: "6869" })).toBe("hi");
  });
  it("decodes a base64url payload without padding", () => {
    const enc = runEncoding({ op: "encode", codec: "base64url", text: "hello?>" });
    expect(runEncoding({ op: "decode", codec: "base64url", text: enc })).toBe("hello?>");
  });
  it("throws a friendly error on invalid base64 / hex / url", () => {
    expect(() => runEncoding({ op: "decode", codec: "base64", text: "!!!not base64!!!" })).toThrow(/base64/i);
    expect(() => runEncoding({ op: "decode", codec: "hex", text: "xyz" })).toThrow(/hex/i);
    expect(() => runEncoding({ op: "decode", codec: "url", text: "%zz" })).toThrow(/URL/i);
  });
  it("decodes a JWT payload to pretty JSON, never verifying the signature", () => {
    // header {alg:HS256}.payload {sub:123,name:"Sam"}.sig
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEyMywibmFtZSI6IlNhbSJ9.whatever";
    const out = runEncoding({ op: "decode", codec: "jwt", text: jwt });
    expect(out).toMatch(/"sub": 123/);
    expect(out).toMatch(/"name": "Sam"/);
  });
  it("throws on a non-JWT string", () => {
    expect(() => runEncoding({ op: "decode", codec: "jwt", text: "notajwt" })).toThrow(/JWT/i);
  });
});

describe("formatEncoding", () => {
  it("wraps the result in a copy span with a label", () => {
    const out = formatEncoding({ op: "encode", codec: "base64", text: "hi" }, "aGk=");
    expect(out).toContain("`aGk=`");
    expect(out).toMatch(/base64 encoded/i);
  });
  it("adds a signature-not-verified note for a JWT", () => {
    const out = formatEncoding({ op: "decode", codec: "jwt", text: "x.y.z" }, "{}");
    expect(out).toMatch(/don't verify the signature/i);
  });
});
