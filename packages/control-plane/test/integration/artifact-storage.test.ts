import { describe, expect, it } from "vitest";
import { initSession } from "./helpers";

describe("recording artifact storage endpoints", () => {
  it("uploads recording and streams full content", async () => {
    const { stub } = await initSession();
    const payload = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));

    const uploadResponse = await stub.fetch(
      "http://internal/internal/artifacts/upload?filename=proof.webm&mimeType=video/webm",
      {
        method: "POST",
        headers: {
          "Content-Type": "video/webm",
          "Content-Length": String(payload.byteLength),
          "X-Artifact-Type": "recording",
          "X-Artifact-Metadata": JSON.stringify({ durationMs: 1234 }),
        },
        body: payload,
      }
    );
    expect(uploadResponse.status).toBe(200);

    const uploadBody = await uploadResponse.json<{ storageKey: string; expiresAt: number }>();
    expect(uploadBody.storageKey).toContain("/recordings/");
    expect(uploadBody.expiresAt).toEqual(expect.any(Number));

    const contentResponse = await stub.fetch(
      `http://internal/internal/artifacts/content?key=${encodeURIComponent(uploadBody.storageKey)}&userId=user-1`
    );
    expect(contentResponse.status).toBe(200);
    expect(contentResponse.headers.get("content-type")).toBe("video/webm");
    expect(contentResponse.headers.get("accept-ranges")).toBe("bytes");

    const contentBytes = new Uint8Array(await contentResponse.arrayBuffer());
    expect(Array.from(contentBytes)).toEqual(Array.from(payload));
  });

  it("serves range requests for recording content", async () => {
    const { stub } = await initSession();
    const payload = new Uint8Array(Array.from({ length: 128 }, (_, i) => i));

    const uploadResponse = await stub.fetch(
      "http://internal/internal/artifacts/upload?filename=proof.webm&mimeType=video/webm",
      {
        method: "POST",
        headers: {
          "Content-Type": "video/webm",
          "Content-Length": String(payload.byteLength),
          "X-Artifact-Type": "recording",
          "X-Artifact-Metadata": "{}",
        },
        body: payload,
      }
    );
    const { storageKey } = await uploadResponse.json<{ storageKey: string }>();

    const rangeResponse = await stub.fetch(
      `http://internal/internal/artifacts/content?key=${encodeURIComponent(storageKey)}&userId=user-1`,
      {
        headers: { Range: "bytes=10-19" },
      }
    );
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("content-range")).toBe(`bytes 10-19/${payload.byteLength}`);
    expect(rangeResponse.headers.get("content-length")).toBe("10");

    const bytes = new Uint8Array(await rangeResponse.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(payload.slice(10, 20)));
  });

  it("rejects suspicious traversal-like artifact keys", async () => {
    const { stub } = await initSession();
    const payload = new Uint8Array([1, 2, 3, 4]);

    const uploadResponse = await stub.fetch(
      "http://internal/internal/artifacts/upload?filename=proof.webm&mimeType=video/webm",
      {
        method: "POST",
        headers: {
          "Content-Type": "video/webm",
          "Content-Length": String(payload.byteLength),
          "X-Artifact-Type": "recording",
          "X-Artifact-Metadata": "{}",
        },
        body: payload,
      }
    );
    const { storageKey } = await uploadResponse.json<{ storageKey: string }>();
    const traversalLikeKey = storageKey.replace("/recordings/", "/recordings/../");

    const response = await stub.fetch(
      `http://internal/internal/artifacts/content?key=${encodeURIComponent(traversalLikeKey)}&userId=user-1`
    );
    expect(response.status).toBe(403);
  });

  it("rejects unsupported recording mime type on upload", async () => {
    const { stub } = await initSession();
    const payload = new Uint8Array([1, 2, 3]);

    const response = await stub.fetch(
      "http://internal/internal/artifacts/upload?filename=proof.webm&mimeType=text/html",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/html",
          "Content-Length": String(payload.byteLength),
          "X-Artifact-Type": "recording",
          "X-Artifact-Metadata": "{}",
        },
        body: payload,
      }
    );

    expect(response.status).toBe(400);
  });
});
