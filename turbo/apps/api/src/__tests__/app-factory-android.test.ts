import {
  CLIENT_TYPE_ANDROID,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { createApp } from "../app-factory";
import { healthRoutes } from "../signals/routes/health";
import {
  androidClientCompatibility,
  iosClientCompatibility,
  testContext,
} from "./test-context";

const context = testContext();

describe("Android installed-client compatibility at the API boundary", () => {
  it.each(["GET", "POST"])(
    "rejects an unsupported Android build before %s route matching",
    async (method) => {
      androidClientCompatibility.minimumSupportedVersion = "0.2.0";
      const app = createApp({ signal: context.signal, routes: healthRoutes });
      const response = await app.request(
        method === "GET" ? "/health" : "/api/user-preferences/initialize",
        {
          method,
          headers: {
            [CLIENT_TYPE_HEADER]: CLIENT_TYPE_ANDROID,
            [CLIENT_VERSION_HEADER]: "0.1.0",
          },
        },
      );
      expect(response.status).toBe(426);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toStrictEqual({
        error: {
          code: "ANDROID_UPDATE_REQUIRED",
          message: "Update Okou for Android to continue.",
        },
        minimumSupportedVersion: "0.2.0",
      });
    },
  );

  it.each([
    ["Android", "0.2.0"],
    ["Android", "1.0.0"],
    ["Android", "development"],
    ["Android", undefined],
    ["android", "0.1.0"],
    ["iOS", iosClientCompatibility.minimumSupportedVersion ?? "0.1.0"],
    ["Desktop", "0.1.0"],
    [undefined, "0.1.0"],
  ])(
    "preserves independently supported or non-Android calls (%s, %s)",
    async (type, version) => {
      androidClientCompatibility.minimumSupportedVersion = "0.2.0";
      const headers = new Headers();
      if (type) {
        headers.set(CLIENT_TYPE_HEADER, type);
      }
      if (version) {
        headers.set(CLIENT_VERSION_HEADER, version);
      }
      const response = await createApp({
        signal: context.signal,
        routes: healthRoutes,
      }).request("/health", { headers });
      expect(response.status).toBe(200);
    },
  );

  it("does not enforce a floor before a verified Android release", async () => {
    androidClientCompatibility.minimumSupportedVersion = null;
    const response = await createApp({
      signal: context.signal,
      routes: healthRoutes,
    }).request("/health", {
      headers: {
        [CLIENT_TYPE_HEADER]: "Android",
        [CLIENT_VERSION_HEADER]: "0.0.1",
      },
    });
    expect(response.status).toBe(200);
  });
});
