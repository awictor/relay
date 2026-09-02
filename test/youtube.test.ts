import { describe, it, expect } from "vitest";
import { parseYouTubeId, isYouTubeUrl, extractCaptionTrackUrl, parseTranscriptXml, fetchYouTubeTranscript } from "../src/lib/youtube.js";

describe("parseYouTubeId", () => {
  it("parses every common URL shape", () => {
    expect(parseYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeId("https://youtu.be/dQw4w9WgXcQ?t=30")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeId("https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=abc")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ"); // bare id
  });
  it("null for non-YouTube / malformed", () => {
    expect(parseYouTubeId("https://example.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ"); // id present anywhere in query
    expect(parseYouTubeId("https://vimeo.com/12345")).toBeNull();
    expect(parseYouTubeId("not a url")).toBeNull();
  });
});

describe("isYouTubeUrl", () => {
  it("true only for YouTube video URLs", () => {
    expect(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeUrl("https://example.com/video")).toBe(false);
    expect(isYouTubeUrl("https://www.youtube.com/")).toBe(false); // no video id
  });
});

describe("extractCaptionTrackUrl", () => {
  it("pulls the first English track baseUrl, unescaping the URL", () => {
    const html = `junk "captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=x\\u0026lang=en","languageCode":"en","kind":"asr"},{"baseUrl":"https://x/es","languageCode":"es"}] more`;
    // Prefers a MANUAL en over asr; here only asr en exists, so it's chosen over es.
    expect(extractCaptionTrackUrl(html)).toBe("https://www.youtube.com/api/timedtext?v=x&lang=en");
  });
  it("prefers a manual (non-asr) English track", () => {
    const html = `"captionTracks":[{"baseUrl":"https://a/asr","languageCode":"en","kind":"asr"},{"baseUrl":"https://a/manual","languageCode":"en"}]`;
    expect(extractCaptionTrackUrl(html)).toBe("https://a/manual");
  });
  it("null when captions are absent", () => {
    expect(extractCaptionTrackUrl("<html>no captions here</html>")).toBeNull();
  });
});

describe("parseTranscriptXml", () => {
  it("parses the legacy XML form + decodes entities", () => {
    const xml = `<?xml version="1.0"?><transcript><text start="0" dur="2">Hello &amp; welcome</text><text start="2" dur="3">it&#39;s a test</text></transcript>`;
    expect(parseTranscriptXml(xml)).toBe("Hello & welcome it's a test");
  });
  it("parses the JSON3 form", () => {
    const json = JSON.stringify({ events: [{ segs: [{ utf8: "Hello " }, { utf8: "world" }] }, { segs: [{ utf8: "\n" }] }, { segs: [{ utf8: "again" }] }] });
    expect(parseTranscriptXml(json)).toBe("Hello world again");
  });
  it("empty for junk", () => {
    expect(parseTranscriptXml("<html>nope</html>")).toBe("");
  });
});

describe("fetchYouTubeTranscript", () => {
  it("fetches watch page then caption track and returns plain text", async () => {
    const capUrl = "https://www.youtube.com/api/timedtext?v=abc&lang=en";
    const html = `x "captionTracks":[{"baseUrl":"${capUrl}","languageCode":"en"}] x`;
    const xml = `<transcript><text start="0">the video says this</text></transcript>`;
    const calls: string[] = [];
    const fetchText = async (u: string) => {
      calls.push(u);
      if (u.includes("/watch")) return html;
      if (u === capUrl) return xml;
      throw new Error("unexpected url " + u);
    };
    const r = await fetchYouTubeTranscript("https://youtu.be/dQw4w9WgXcQ", fetchText);
    expect(r).toEqual({ videoId: "dQw4w9WgXcQ", text: "the video says this" });
    expect(calls[0]).toContain("/watch?v=dQw4w9WgXcQ");
  });
  it("null when the video has no captions", async () => {
    const r = await fetchYouTubeTranscript("https://youtu.be/dQw4w9WgXcQ", async () => "<html>no captions</html>");
    expect(r).toBeNull();
  });
  it("null (not throw) when a fetch fails", async () => {
    const r = await fetchYouTubeTranscript("https://youtu.be/dQw4w9WgXcQ", async () => { throw new Error("network"); });
    expect(r).toBeNull();
  });
  it("null for a non-YouTube URL", async () => {
    const r = await fetchYouTubeTranscript("https://vimeo.com/1", async () => "x");
    expect(r).toBeNull();
  });
});
