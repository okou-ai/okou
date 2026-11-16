import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  androidUpdatesContract,
  type AndroidRelease,
} from "@okouai/api-contracts/contracts/android-updates";
import { createApp } from "../../../app-factory";
import {
  accept,
  androidClientCompatibility,
  testContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { androidUpdateRoutes } from "../android-updates";

const context = testContext();
const routes = Object.freeze([...androidUpdateRoutes]);
const manifestUrl = "https://static.okou.io/android-updates/manifest.json";
const release = Object.freeze({
  version: "0.14.1",
  minimumSdk: 24,
  size: 1234,
  sha256: "a".repeat(64),
  notes: "A native update",
  url: `https://static.okou.io/android-updates/releases/0.14.1/${"a".repeat(64)}.apk`,
});

function apiClient(rethrowErrors = false) {
  return setupApp({ context, routes, rethrowErrors })(androidUpdatesContract);
}

function serveRelease(value: AndroidRelease = release) {
  const bytes = Buffer.from(
    JSON.stringify({ schemaVersion: 1, release: value }),
  );
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof GetObjectCommand &&
      command.input.Bucket === env("R2_STATIC_BUCKET_NAME") &&
      command.input.Key === "android-updates/manifest.json"
    ) {
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      });
    }
    return Promise.reject(
      Object.assign(new Error("Object unavailable"), { name: "NoSuchKey" }),
    );
  });
}

function appRequest(path: string, method = "GET") {
  return createApp({ signal: context.signal, routes }).request(path, {
    method,
    headers: { "X-Client-Type": "Android", "X-Client-Version": "0.1.0" },
  });
}

describe("Android public update recovery", () => {
  it("retains a precise public bootstrap after business API exclusion", async () => {
    androidClientCompatibility.minimumSupportedVersion = "0.12.0";
    serveRelease();
    const response = await accept(
      apiClient().get({
        extraHeaders: {
          "X-Client-Type": "Android",
          "X-Client-Version": "0.1.0",
        },
      }),
      [200],
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toStrictEqual({
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
    const anonymous = await accept(apiClient().get(), [200]);
    expect(anonymous.body).toStrictEqual({
      minimumSupportedVersion: null,
      release,
    });
  });

  it("discovers successive R2 releases while the public manifest is stale", async () => {
    server.use(
      http.get(manifestUrl, () => {
        return HttpResponse.json({
          schemaVersion: 1,
          release: {
            ...release,
            version: "0.14.0",
            url: release.url.replace("0.14.1", "0.14.0"),
          },
        });
      }),
    );
    context.mocks.s3.requestConfig.mockImplementation((config: unknown) => {
      expect(config).toMatchObject({
        endpoint: "https://test-account.r2.cloudflarestorage.com",
        credentials: {
          accessKeyId: "test-static-access-key",
          secretAccessKey: "test-static-secret-key",
        },
      });
    });
    const api = apiClient();
    serveRelease();
    expect((await accept(api.get(), [200])).body.release).toStrictEqual(
      release,
    );
    const next = {
      ...release,
      version: "0.14.2",
      url: release.url.replace("0.14.1", "0.14.2"),
    };
    serveRelease(next);
    expect((await accept(api.get(), [200])).body.release).toStrictEqual(next);
  });

  it.each([
    [
      "missing object",
      Object.assign(new Error("Object unavailable"), { name: "NoSuchKey" }),
    ],
    [
      "temporary S3 failure",
      Object.assign(new Error("Service unavailable"), {
        $metadata: { httpStatusCode: 503 },
      }),
    ],
    [
      "connection reset",
      Object.assign(new Error("Connection reset"), { code: "ECONNRESET" }),
    ],
  ])("reports %s as an unavailable release", async (_label, error) => {
    androidClientCompatibility.minimumSupportedVersion = "0.12.0";
    context.mocks.s3.send.mockRejectedValue(error);
    const unavailable = await accept(apiClient().get(), [503]);
    expect(unavailable.headers.get("retry-after")).toBe("60");
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(unavailable.body.error.code).toBe("ANDROID_UPDATE_UNAVAILABLE");
    expect((await appRequest("/api/org")).status).toBe(426);
  });

  it("reports an owned storage timeout as retryable", async () => {
    const deadline = new AbortController();
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 5000 ? deadline.signal : undefined;
    });
    context.mocks.s3.send.mockImplementation(() => {
      deadline.abort(new DOMException("Storage deadline", "TimeoutError"));
      return Promise.reject(new DOMException("Request aborted", "AbortError"));
    });
    const unavailable = await accept(apiClient().get(), [503]);
    expect(unavailable.body.error.code).toBe("ANDROID_UPDATE_UNAVAILABLE");
  });

  it("surfaces missing static credentials as a configuration error", async () => {
    mockEnv("R2_STATIC_SECRET_ACCESS_KEY", undefined);
    await expect(apiClient(true).get()).rejects.toThrow(
      "Static storage credentials are not configured",
    );
  });

  it("surfaces an incorrect static bucket as a configuration error", async () => {
    context.mocks.s3.send.mockRejectedValue(
      Object.assign(new Error("The specified bucket does not exist"), {
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      }),
    );
    await expect(apiClient(true).get()).rejects.toThrow(
      "The specified bucket does not exist",
    );
  });

  it("preserves caller cancellation instead of reporting a retryable release", async () => {
    const caller = new AbortController();
    context.mocks.s3.send.mockImplementation(() => {
      caller.abort(new DOMException("Caller aborted", "AbortError"));
      return Promise.reject(new DOMException("Request aborted", "AbortError"));
    });
    const api = setupApp({
      context,
      routes,
      signal: caller.signal,
      rethrowErrors: true,
    })(androidUpdatesContract);
    await expect(api.get()).rejects.toThrow("Caller aborted");
  });

  it("surfaces oversized publication bytes as an error", async () => {
    context.mocks.s3.send.mockResolvedValue({
      ContentLength: 65_537,
      Body: Readable.from([Buffer.alloc(65_537)]),
    });
    await expect(apiClient(true).get()).rejects.toThrow(
      "S3 object is too large",
    );
  });

  it("validates the published APK identity", async () => {
    serveRelease({ ...release, url: "https://example.com/untrusted.apk" });
    await expect(apiClient(true).get()).rejects.toThrow(
      "Android release identity is inconsistent",
    );
  });
});
