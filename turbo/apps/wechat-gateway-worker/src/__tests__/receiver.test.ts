import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { convertV4MiniflareOptions, Miniflare, Response } from "miniflare";
import { expect, it, onTestFinished } from "vitest";
const control = randomUUID();
const secret = randomUUID();
const connectionId = "00000000-0000-4000-8000-000000000001";
function fixture(enabled = true) {
  const received = Promise.withResolvers<{
    body: string;
    timestamp: string | null;
    signature: string | null;
  }>();
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: "wechat-test",
      scriptPath: fileURLToPath(
        new NodeURL("../../dist/index.js", import.meta.url),
      ),
      modules: true,
      compatibilityFlags: ["nodejs_compat"],
      workflows: {
        WECHAT_POLL_WORKFLOW: {
          name: "wechat-poll-test",
          className: "WechatPollWorkflow",
        },
      },
      compatibilityDate: "2026-09-03",
      cf: false,
      telemetry: { enabled: false },
      durableObjects: {
        WECHAT_RECEIVER: { className: "WechatReceiver", useSQLite: true },
      },
      bindings: {
        WECHAT_GATEWAY_ENABLED: String(enabled),
        WECHAT_WORKFLOWS_ENABLED: "false",
        WECHAT_GATEWAY_SECRET: secret,
        WECHAT_GATEWAY_CONTROL_SECRET: control,
        API_ORIGIN: "https://api.example.test",
      },
      outboundService: async (request) => {
        expect(request.url).toBe(
          "https://api.example.test/api/internal/wechat/poll",
        );
        const body = await request.text();
        received.resolve({
          body,
          timestamp: request.headers.get("x-wechat-timestamp"),
          signature: request.headers.get("x-wechat-signature"),
        });
        return Response.json({ active: false });
      },
    }),
  );
  onTestFinished(() => {
    return runtime.dispose();
  });
  return { runtime, received: received.promise };
}
it("requires authenticated control and remains disabled by default", async () => {
  const disabled = fixture(false);
  expect(
    (
      await disabled.runtime.dispatchFetch("https://worker/start", {
        method: "POST",
        headers: { Authorization: `Bearer ${control}` },
        body: JSON.stringify({ connectionId }),
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await disabled.runtime.dispatchFetch("https://worker/stop", {
        method: "POST",
        headers: { Authorization: `Bearer ${control}` },
        body: JSON.stringify({ connectionId }),
      })
    ).status,
  ).toBe(200);
  const enabled = fixture();
  expect(
    (
      await enabled.runtime.dispatchFetch("https://worker/start", {
        method: "POST",
        body: JSON.stringify({ connectionId }),
      })
    ).status,
  ).toBe(401);
});
it("an authorized start durably schedules a signed canonical API request", async () => {
  const { runtime, received } = fixture();
  expect(
    (
      await runtime.dispatchFetch("https://worker/start", {
        method: "POST",
        headers: { Authorization: `Bearer ${control}` },
        body: JSON.stringify({ connectionId }),
      })
    ).status,
  ).toBe(200);
  const call = await received;
  expect(JSON.parse(call.body)).toEqual({ connectionId });
  expect(call.signature).toBe(
    createHmac("sha256", secret)
      .update(`${call.timestamp}.${call.body}`)
      .digest("hex"),
  );
});
