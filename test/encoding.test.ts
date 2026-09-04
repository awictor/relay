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

describe("hashing + rot13 (encode-hash-rot13)", () => {
  const run = (t: string) => { const p = parseEncodingRequest(t); return p ? runEncoding(p) : null; };
  it("sha256/sha1/md5 match known vectors (deterministic, no guessing)", () => {
    expect(run("sha256 of hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(run("md5 of hello")).toBe("5d41402abc4b2a76b9719d911017c592");
    expect(run("sha1 hash of abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(run("hash this with sha256: password")).toBe("5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8");
  });
  it("a request to reverse/decode a hash is refused, not faked", () => {
    const p = parseEncodingRequest("reverse this sha256 abc123")!;
    expect(p.op).toBe("decode");
    expect(() => runEncoding(p)).toThrow(/one-way hash/);
  });
  it("rot13 encodes and round-trips (its own inverse)", () => {
    expect(run("rot13 hello")).toBe("uryyb");
    expect(run("rot13 encode Uryyb")).toBe("Hello");   // preserves case, non-letters
    expect(run("decode rot13 Uryyb")).toBe("Hello");
    expect(run("rot13 Hello, World! 123")).toBe("Uryyb, Jbeyq! 123");
  });
  it("formats a hash with a 'hash' label, not 'encoded'", () => {
    const p = parseEncodingRequest("sha256 of hi")!;
    expect(formatEncoding(p, runEncoding(p))).toMatch(/sha256 hash/i);
  });
  it("existing codecs still work (regression)", () => {
    expect(run("base64 encode hello")).toBe("aGVsbG8=");
    expect(run("decode hex 6869")).toBe("hi");
  });
});

describe("binary <-> text (encode-binary-text)", () => {
  const run = (t: string) => { const p = parseEncodingRequest(t); return p ? runEncoding(p) : null; };
  it("encodes text to 8-bit bytes from either phrasing", () => {
    expect(run("binary of A")).toBe("01000001");
    expect(run("hi in binary")).toBe("01101000 01101001");
    expect(run("hello world in binary")).toBe("01101000 01100101 01101100 01101100 01101111 00100000 01110111 01101111 01110010 01101100 01100100");
  });
  it("decodes binary to text (spaced or unspaced), inferring op from the 0/1 payload", () => {
    expect(run("decode this binary 01001000 01101001")).toBe("Hi");
    expect(run("binary 01000001")).toBe("A");               // bare payload of 0/1 -> decode
    expect(run("decode binary 0100100001101001")).toBe("Hi"); // no spaces
    expect(run("binary to text 01001000 01101001")).toBe("Hi");
  });
  it("round-trips + multi-byte UTF-8", () => {
    const p = parseEncodingRequest("binary of café")!;
    const bin = runEncoding(p);
    const back = runEncoding(parseEncodingRequest(`decode binary ${bin}`)!);
    expect(back).toBe("café");
  });
  it("rejects malformed binary (not a multiple of 8 bits)", () => {
    const p = parseEncodingRequest("decode binary 0100100")!; // 7 bits
    expect(() => runEncoding(p)).toThrow(/valid binary/);
  });
});

describe("morse code (encode-morse)", () => {
  const run = (t: string) => { const p = parseEncodingRequest(t); return p ? runEncoding(p) : null; };
  it("encodes text to morse from either phrasing, words split on '/'", () => {
    expect(run("morse code SOS")).toBe("... --- ...");
    expect(run("SOS in morse")).toBe("... --- ...");
    expect(run("morse hello world")).toBe(".... . .-.. .-.. --- / .-- --- .-. .-.. -..");
    expect(run("morse of 123")).toBe(".---- ..--- ...--");
  });
  it("decodes morse to text, inferring op from the dot/dash payload", () => {
    expect(run("decode morse ... --- ...")).toBe("sos");
    expect(run("decode this morse: .... .. / -- --- --")).toBe("hi mom");
  });
  it("round-trips", () => {
    const enc = run("hello in morse")!;
    expect(run(`decode morse ${enc}`)).toBe("hello");
  });
  it("errors on an un-encodable char and invalid morse", () => {
    expect(() => runEncoding(parseEncodingRequest("morse of ~")!)).toThrow(/can't Morse-encode/);
    expect(() => runEncoding(parseEncodingRequest("decode morse ........")!)).toThrow(/isn't valid Morse/);
  });
});
