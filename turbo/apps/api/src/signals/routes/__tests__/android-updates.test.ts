import { Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  androidUpdatesContract,
  type AndroidRelease,
} from "@okouai/api-contracts/contracts/android-updates";
import {
  CLIENT_TYPE_ANDROID,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  accept,
  androidClientCompatibility,
  testContext,
} from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { androidUpdateRoutes } from "../android-updates";
import { orgReadRoutes } from "../org-read";

const context = testContext();
const updates = setupApp({ context, routes: androidUpdateRoutes })(
  androidUpdatesContract,
);
const rawRequest = setupRawAppRequest({
  context,
  routes: [...androidUpdateRoutes, ...orgReadRoutes],
});
const androidClient = Object.freeze({
  [CLIENT_TYPE_HEADER]: CLIENT_TYPE_ANDROID,
  [CLIENT_VERSION_HEADER]: "0.1.0",
});

function release(version: string, sha: string): AndroidRelease {
  const sha256 = sha.repeat(64);
  return {
    version,
    minimumSdk: 26,
    size: 48_000_000,
    sha256,
    url: `https://static.okou.io/android-updates/releases/${version}/${sha256}.apk`,
    notes: `Okou for Android ${version}`,
  };
}

function manifestObject(published: AndroidRelease) {
  const body = Buffer.from(
    JSON.stringify({ schemaVersion: 1, release: published }),
  );
  return {
    Body: Readable.from([body]),
    ContentLength: body.length,
    $metadata: { httpStatusCode: 200 },
  };
}

function publishInStaticStorage(read: () => AndroidRelease): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof GetObjectCommand &&
      command.input.Bucket === env("R2_STATIC_BUCKET_NAME") &&
      command.input.Key === "android-updates/manifest.json"
    ) {
      return Promise.resolve(manifestObject(read()));
    }
    return Promise.reject(new Error("Unexpected static storage request"));
  });
}

function failStaticStorage(error: Error): void {
  context.mocks.s3.send.mockRejectedValue(error);
}

async function expectBusinessApiExclusion(): Promise<void> {
  const org = await rawRequest("/api/org", {
    method: "GET",
    headers: { ...androidClient, authorization: "Bearer clerk-session" },
  });
  expect(org.status).toBe(426);
}

describe("Android public update recovery", () => {
  it("android-updates-001 keeps the public update check open for an excluded Android client", async () => {
    androidClientCompatibility.minimumSupportedVersion = "0.12.0";
    const published = release("0.14.1", "a");
    publishInStaticStorage(() => {
      return published;
    });

    const current = await accept(
      updates.get({ extraHeaders: androidClient }),
      [200],
    );
    expect(current.headers.get("cache-control")).toBe("no-store");
    expect(current.body).toStrictEqual({
      minimumSupportedVersion: "0.12.0",
      release: published,
    });

    await expectBusinessApiExclusion();
    const otherUpdatePath = await rawRequest("/api/android/updates/other", {
      method: "GET",
      headers: androidClient,
    });
    expect(otherUpdatePath.status).toBe(426);
    const updateWrite = await rawRequest("/api/android/updates", {
      method: "POST",
      headers: androidClient,
    });
    expect(updateWrite.status).toBe(426);

    androidClientCompatibility.minimumSupportedVersion = null;
    const anonymous = await accept(updates.get(), [200]);
    expect(anonymous.body).toStrictEqual({
      minimumSupportedVersion: null,
      release: published,
    });
  });

  it("android-updates-002 serves each new R2 release while the public manifest is stale", async () => {
    server.use(
      http.get("https://static.okou.io/android-updates/manifest.json", () => {
        return HttpResponse.json({
          schemaVersion: 1,
          release: release("0.14.0", "0"),
        });
      }),
    );
    let stored = release("0.14.1", "b");
    publishInStaticStorage(() => {
      return stored;
    });

    const first = await accept(updates.get(), [200]);
    expect(first.body.release).toStrictEqual(release("0.14.1", "b"));
    expect(context.mocks.s3.requestConfig.mock.lastCall).toStrictEqual([
      expect.objectContaining({
        credentials: {
          accessKeyId: env("R2_STATIC_ACCESS_KEY_ID"),
          secretAccessKey: env("R2_STATIC_SECRET_ACCESS_KEY"),
        },
      }),
    ]);

    stored = release("0.14.2", "c");
    const second = await accept(updates.get(), [200]);
    expect(second.body.release).toStrictEqual(release("0.14.2", "c"));
  });

  it("android-updates-003 reports a missing manifest object as a retryable unavailable release", async () => {
    androidClientCompatibility.minimumSupportedVersion = "0.12.0";
    failStaticStorage(
      Object.assign(new Error("The specified key does not exist."), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      }),
    );

    const unavailable = await accept(updates.get(), [503]);
    expect(unavailable.headers.get("retry-after")).toBe("60");
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(unavailable.body.error.code).toBe("ANDROID_UPDATE_UNAVAILABLE");
    await expectBusinessApiExclusion();
  });

  it("android-updates-004 reports a temporary storage outage as a retryable unavailable release", async () => {
    androidClientCompatibility.minimumSupportedVersion = "0.12.0";
    failStaticStorage(
      Object.assign(new Error("Service Unavailable"), {
        name: "ServiceUnavailable",
        $metadata: { httpStatusCode: 503 },
      }),
    );

    const unavailable = await accept(updates.get(), [503]);
    expect(unavailable.headers.get("retry-after")).toBe("60");
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(unavailable.body.error.code).toBe("ANDROID_UPDATE_UNAVAILABLE");
    await expectBusinessApiExclusion();
  });

  it("android-updates-011 rejects a published APK that does not match the release identity", async () => {
    publishInStaticStorage(() => {
      return {
        ...release("0.14.1", "d"),
        url: "https://example.com/untrusted.apk",
      };
    });

    await expect(
      setupApp({ context, routes: androidUpdateRoutes, rethrowErrors: true })(
        androidUpdatesContract,
      ).get(),
    ).rejects.toThrow("Android release identity is inconsistent");
  });
});
