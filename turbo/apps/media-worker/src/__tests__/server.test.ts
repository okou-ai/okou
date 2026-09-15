import { once } from "node:events";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { createPosterServer } from "../server";

import { fixture, pixelData, serve } from "./media-fixture";

const secret = "media-worker-test-secret-with-32-chars";

async function start(maxConcurrency = 2, requestTimeoutMs = 20_000) {
  const server = createPosterServer({
    secret,
    port: 0,
    maxConcurrency,
    requestTimeoutMs,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  onTestFinished(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  return `http://127.0.0.1:${port}`;
}

async function hostedVideo() {
  const media = await fixture(45);
  const host = await serve(media.directory);
  onTestFinished(async () => {
    await host.close();
    await rm(media.directory, { recursive: true, force: true });
  });
  return host.url(media.name);
}

function poster(
  base: string,
  body: unknown,
  authorization = `Bearer ${secret}`,
) {
  return fetch(`${base}/poster`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("poster service", () => {
  it("renders a poster for an authorized request", async () => {
    const base = await start();
    const response = await poster(base, { sourceUrl: await hostedVideo() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const image = Buffer.from(await response.arrayBuffer());
    expect((await pixelData(image))[2]).toBeGreaterThan(240);
  });

  it("reports liveness without the secret", async () => {
    const base = await start();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["Bearer wrong-secret-with-enough-characters", 401],
    ["", 401],
  ])("rejects credentials %s", async (authorization, status) => {
    const base = await start();
    const response = await poster(
      base,
      { sourceUrl: "https://example.invalid/video.mp4" },
      authorization,
    );
    expect(response.status).toBe(status);
  });

  it.each([
    [{ sourceUrl: "file:///etc/passwd" }],
    [{ sourceUrl: "not-a-url" }],
    [{}],
  ])("rejects an unusable request body %o", async (body) => {
    const base = await start();
    const response = await poster(base, body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      code: "invalid_request",
    });
  });

  it("reports an unreadable source as a decode failure", async () => {
    const base = await start();
    const response = await poster(base, {
      sourceUrl: "http://127.0.0.1:1/missing.mp4",
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toStrictEqual({
      code: "decode_failed",
    });
  });

  it("sheds load past the concurrency limit", async () => {
    const base = await start(1);
    const sourceUrl = await hostedVideo();
    const [first, second] = await Promise.all([
      poster(base, { sourceUrl }),
      poster(base, { sourceUrl }),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => {
      return a - b;
    });
    await Promise.all([first.arrayBuffer(), second.arrayBuffer()]);
    expect(statuses).toStrictEqual([200, 503]);
  });

  it("returns 404 for an unknown path", async () => {
    const base = await start();
    const response = await fetch(`${base}/unknown`);
    expect(response.status).toBe(404);
  });
});
