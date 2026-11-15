import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { createApp } from "../../../app-factory";
import {
  androidClientCompatibility,
  testContext,
} from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { androidUpdateRoutes } from "../android-updates";

const context = testContext();
const routes = Object.freeze([...androidUpdateRoutes]);
const manifestUrl = "https://static.okou.io/android-updates/manifest.json";
const release = Object.freeze({
  version: "0.13.0",
  versionCode: 13_000,
  minimumSdk: 24,
  size: 1234,
  sha256: "a".repeat(64),
  notes: "A native update",
  url: `https://static.okou.io/android-updates/releases/0.13.0/${"a".repeat(64)}.apk`,
});

function appRequest(path: string, method = "GET") {
  return createApp({ signal: context.signal, routes }).request(path, {
    method,
    headers: { "X-Client-Type": "Android", "X-Client-Version": "0.1.0" },
  });
}

describe("Android public update recovery", () => {
  it("retains a precise public bootstrap after business API exclusion", async () => {
    androidClientCompatibility.minimumSupportedVersion = "0.12.0";
    server.use(
      http.get(manifestUrl, () => {
        return HttpResponse.json({ schemaVersion: 1, release });
      }),
    );
    const response = await appRequest("/api/android/updates");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toStrictEqual({
      minimumSupportedVersion: "0.12.0",
      release,
    });
    for (const [path, method] of [
      ["/api/org", "GET"],
      ["/api/android/updates/other", "GET"],
      ["/api/android/updates", "POST"],
    ]) {
      expect((await appRequest(path!, method!)).status).toBe(426);
    }
    androidClientCompatibility.minimumSupportedVersion = null;
    const anonymous = await createApp({
      signal: context.signal,
      routes,
    }).request("/api/android/updates");
    expect(anonymous.status).toBe(200);
    await expect(anonymous.json()).resolves.toStrictEqual({
      minimumSupportedVersion: null,
      release,
    });
  });

  it("reports an unavailable release without claiming that an excluded client is current", async () => {
    androidClientCompatibility.minimumSupportedVersion = "0.12.0";
    server.use(
      http.get(manifestUrl, () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );
    const unavailable = await appRequest("/api/android/updates");
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("60");
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect((await appRequest("/api/org")).status).toBe(426);
  });
});
