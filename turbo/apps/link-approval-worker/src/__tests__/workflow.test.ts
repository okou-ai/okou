import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { convertV4MiniflareOptions, Miniflare, Response } from "miniflare";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { Env } from "../workflow";

const secret = randomUUID();
const control = "approval-control-test-secret-11111111";

function fixture(handler: (spendId: string) => Response, enabled = "true") {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: "link-approval-test",
      scriptPath: fileURLToPath(
        new URL("../../dist/index.js", import.meta.url),
      ),
      modules: true,
      compatibilityDate: "2026-09-03",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      telemetry: { enabled: false },
      workflows: {
        LINK_APPROVAL_WORKFLOW: {
          name: "link-approval-test",
          className: "LinkApprovalWorkflow",
        },
      },
      bindings: {
        LINK_APPROVAL_ENABLED: enabled,
        LINK_APPROVAL_API_ORIGIN: "https://api.example.test",
        LINK_APPROVAL_WORKER_SECRET: secret,
        LINK_APPROVAL_CONTROL_SECRET: control,
      },
      outboundService: async (request) => {
        expect(request.url).toBe(
          "https://api.example.test/api/internal/link-approval/poll",
        );
        const body = await request.text();
        expect(request.headers.get("x-link-approval-signature")).toBe(
          createHmac("sha256", secret)
            .update(
              `${request.headers.get("x-link-approval-timestamp")}.${body}`,
            )
            .digest("hex"),
        );
        const payload = JSON.parse(body) as { spendId: string };
        expect(payload).toEqual({
          spendId: expect.any(String),
        });
        return handler(payload.spendId);
      },
    }),
  );
  return {
    dispose: () => {
      return runtime.dispose();
    },
    start: (
      spendId: string,
      deadline: string,
      authorization = `Bearer ${control}`,
    ) => {
      return runtime.dispatchFetch("https://worker/start", {
        method: "POST",
        headers: { authorization },
        body: JSON.stringify({ spendId, deadline }),
      });
    },
    status: async (spendId: string) => {
      const bindings =
        await runtime.getBindings<Pick<Env, "LINK_APPROVAL_WORKFLOW">>();
      return await (
        await bindings.LINK_APPROVAL_WORKFLOW.get(spendId)
      ).status();
    },
  };
}

it("polls every five seconds inside one block, stops on approval and deduplicates starts", async () => {
  const calls: number[] = [];
  const runtime = fixture(() => {
    calls.push(Date.now());
    return Response.json({ state: calls.length === 1 ? "waiting" : "done" });
  });
  onTestFinished(runtime.dispose);
  const id = randomUUID();
  const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
  const starts = await Promise.all([
    runtime.start(id, deadline),
    runtime.start(id, deadline),
  ]);
  expect(
    starts.map((response) => {
      return response.status;
    }),
  ).toEqual([200, 200]);
  await expect
    .poll(
      async () => {
        return (await runtime.status(id)).status;
      },
      { timeout: 12_000 },
    )
    .toBe("complete");
  expect(calls).toHaveLength(2);
  expect((calls[1] ?? 0) - (calls[0] ?? 0)).toBeGreaterThanOrEqual(4900);
  expect((calls[1] ?? 0) - (calls[0] ?? 0)).toBeLessThan(10_000);
  expect((await runtime.start(id, deadline)).status).toBe(200);
  expect((await runtime.status(id)).status).toBe("complete");
  expect(calls).toHaveLength(2);
}, 20_000);

describe("approval window", () => {
  const polls: string[] = [];
  let runtime: ReturnType<typeof fixture>;
  beforeAll(() => {
    runtime = fixture((spendId) => {
      polls.push(spendId);
      return Response.json({ state: "done" });
    });
    return runtime.dispose;
  });

  it("performs one final observation at the original deadline without starting a fresh polling window", async () => {
    const startCount = polls.length;
    const id = randomUUID();
    expect(
      (await runtime.start(id, new Date(Date.now() - 1000).toISOString()))
        .status,
    ).toBe(200);
    await expect
      .poll(
        async () => {
          return (await runtime.status(id)).status;
        },
        { timeout: 5000 },
      )
      .toBe("complete");
    expect(polls.slice(startCount)).toEqual([id]);
    expect(
      (
        await runtime.start(
          randomUUID(),
          new Date(Date.now() - 121_000).toISOString(),
        )
      ).status,
    ).toBe(410);
    expect(polls.slice(startCount)).toEqual([id]);
  }, 10_000);

  it("rejects unauthorized starts and deadlines beyond the approval window without calling the API", async () => {
    const startCount = polls.length;
    const deadline = new Date(Date.now() + 60_000).toISOString();
    expect(
      (await runtime.start(randomUUID(), deadline, "Bearer wrong")).status,
    ).toBe(401);
    expect(
      (
        await runtime.start(
          randomUUID(),
          new Date(Date.now() + 31 * 60_000).toISOString(),
        )
      ).status,
    ).toBe(410);
    expect((await runtime.start("invalid", deadline)).status).toBe(400);
    expect(polls).toHaveLength(startCount);
  });
});

it("does not start when the Worker kill switch is off", async () => {
  let calls = 0;
  const runtime = fixture(() => {
    calls++;
    return Response.json({ state: "done" });
  }, "false");
  onTestFinished(runtime.dispose);
  expect(
    (
      await runtime.start(
        randomUUID(),
        new Date(Date.now() + 60_000).toISOString(),
      )
    ).status,
  ).toBe(503);
  expect(calls).toBe(0);
});
