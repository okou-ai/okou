import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import { fetchWorker } from "./test-helpers";

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const token = "c".repeat(48);
const grantKey = `private-video-previews/${token}.json`;
const sourceKey =
  "private-artifacts/00000000-0000-4000-8000-000000000009/video.mp4";
const endpoint = "https://files.okou.app/__artifact-video-poster";

function fixture() {
  const grant = {
    version: 1,
    sourceKey,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const objects = new Map<
    string,
    { body: string; type: string; size?: number }
  >([
    [grantKey, { body: JSON.stringify(grant), type: "application/json" }],
    [sourceKey, { body: "private video", type: "video/mp4" }],
  ]);
  const reads: string[] = [];
  const inputs: string[] = [];
  const render = vi.fn(async () => {
    return new Response("JPEG poster", {
      headers: { "Content-Type": "image/jpeg" },
    });
  });
  const env: WorkerEnv = {
    HOST_DOMAIN: "sites.vm0.io",
    OKOU_HOST_DOMAIN: "okou.app",
    HOSTED_SITES_BUCKET: {
      head: async () => {
        return null;
      },
      get: async () => {
        return null;
      },
    },
    PRIVATE_ARTIFACTS_BUCKET: {
      head: async () => {
        return null;
      },
      get: async (key) => {
        reads.push(key);
        const object = objects.get(key);
        return object
          ? {
              body: new Response(object.body).body!,
              size: object.size ?? object.body.length,
              httpEtag: '"video"',
              writeHttpMetadata(headers) {
                headers.set("Content-Type", object.type);
              },
            }
          : null;
      },
    },
    MEDIA: {
      input(body) {
        return {
          transform(options) {
            expect(options).toStrictEqual({ width: 640 });
            return {
              output(options) {
                expect(options).toStrictEqual({
                  mode: "frame",
                  time: "1s",
                  format: "jpg",
                });
                return {
                  response: async () => {
                    inputs.push(await new Response(body).text());
                    return render();
                  },
                };
              },
            };
          },
        };
      },
    },
  };
  const request = (authorization = `Bearer ${token}`, method = "POST") => {
    return new Request(endpoint, {
      method,
      headers: { Authorization: authorization },
    });
  };
  return { env, grant, objects, reads, inputs, render, request };
}

describe("private video poster extraction", () => {
  it("uses private bytes with the Media binding and never caches the response", async () => {
    const f = fixture();
    const response = await fetchWorker(f.request(), f.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toBe("JPEG poster");
    expect(f.inputs).toStrictEqual(["private video"]);
    expect(f.reads).toStrictEqual([grantKey, sourceKey]);

    f.objects.delete(grantKey);
    const denied = await fetchWorker(f.request(), f.env);
    expect(denied.status).toBe(404);
    expect(f.render).toHaveBeenCalledTimes(1);
  });

  it.each(["", "Bearer unknown", `Bearer ${"d".repeat(48)}`])(
    "denies a missing or invalid grant (%s) before reading video bytes",
    async (authorization) => {
      const f = fixture();
      const response = await fetchWorker(f.request(authorization), f.env);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(f.reads).not.toContain(sourceKey);
      expect(f.render).not.toHaveBeenCalled();
    },
  );

  it.each([
    { expiresAt: "2000-01-01T00:00:00.000Z" },
    { version: 2 },
    { sourceKey: "https://private.example/video.mp4" },
    { sourceKey: "private-video-previews/other.json" },
  ])("rejects expired or malformed grants (%j)", async (override) => {
    const f = fixture();
    f.objects.set(grantKey, {
      body: JSON.stringify({ ...f.grant, ...override }),
      type: "application/json",
    });
    expect((await fetchWorker(f.request(), f.env)).status).toBe(404);
    expect(f.reads).toStrictEqual([grantKey]);
    expect(f.render).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD"])(
    "does not expose extraction through %s",
    async (method) => {
      const f = fixture();
      expect(
        (await fetchWorker(f.request(`Bearer ${token}`, method), f.env)).status,
      ).toBe(405);
      expect(f.reads).toStrictEqual([]);
    },
  );

  it.each([{ type: "video/webm" }, { type: "video/mp4", size: 100_000_000 }])(
    "skips unsupported video inputs (%j)",
    async (metadata) => {
      const f = fixture();
      f.objects.set(sourceKey, { body: "video", ...metadata });
      expect((await fetchWorker(f.request(), f.env)).status).toBe(415);
      expect(f.render).not.toHaveBeenCalled();
    },
  );

  it("fails closed when storage or the transformer is unavailable", async () => {
    const f = fixture();
    f.render.mockRejectedValue(new Error("media unavailable"));
    const failed = await fetchWorker(f.request(), f.env);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("Artifact unavailable");
    expect(failed.headers.get("Cache-Control")).toBe("private, no-store");
    const withoutBinding = await fetchWorker(f.request(), {
      ...f.env,
      MEDIA: undefined,
    });
    expect(withoutBinding.status).toBe(503);
    f.objects.delete(sourceKey);
    expect((await fetchWorker(f.request(), f.env)).status).toBe(404);
  });
});
