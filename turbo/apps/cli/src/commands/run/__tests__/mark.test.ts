import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { deferred } from "../../../test-fixtures/ably-realtime";
import { createRunMarkCommand } from "../mark";

const endpoint = "https://api.okou.ai/api/runs/current/phase-mark";
const receipt = { schemaVersion: 2, status: "accepted" };
function token() {
  const payload = Buffer.from(
    JSON.stringify({
      scope: "okou",
      capabilities: [],
      userId: "owner",
      orgId: "org",
      runId: "a0000000-0000-4000-8000-000000000001",
    }),
  ).toString("base64url");
  return `vm0_sandbox_e30.${payload}.signature`;
}
function run(args: string[]) {
  return createRunMarkCommand()
    .exitOverride()
    .configureOutput({
      writeErr: () => {
        return undefined;
      },
    })
    .parseAsync(args, { from: "user" });
}

beforeEach(() => {
  vi.stubEnv("OKOU_TOKEN", token());
  vi.stubEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  vi.spyOn(console, "log").mockImplementation(() => {
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementation(() => {
    return undefined;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("run phase markers", () => {
  it.each([
    ["generation-start"],
    ["generation-start", "--skip-research"],
    ["generation-start", "--kind", "unknown"],
    ["research-start", "--kind", "report"],
  ])(
    "rejects invalid arguments before making a request: %j",
    async (...args) => {
      const requests = vi.fn(() => {
        return HttpResponse.json(receipt, { status: 202 });
      });
      server.use(http.post(endpoint, requests));
      await expect(run(args)).rejects.toThrow();
      expect(requests).not.toHaveBeenCalled();
    },
  );

  it("sends an explicit kind and skip declaration once and stays quiet", async () => {
    const requests = vi.fn(async ({ request }: { request: Request }) => {
      expect(await request.json()).toEqual({
        phase: "generation-start",
        kind: "report",
        skipResearch: true,
      });
      return HttpResponse.json(receipt, { status: 202 });
    });
    server.use(http.post(endpoint, requests));
    await run(["generation-start", "--kind", "report", "--skip-research"]);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("prints the acceptance receipt for an authenticated Run token with no capabilities", async () => {
    const requests = vi.fn(async ({ request }: { request: Request }) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${token()}`);
      expect(await request.json()).toEqual({ phase: "research-start" });
      return HttpResponse.json(receipt, { status: 202 });
    });
    server.use(http.post(endpoint, requests));
    await run(["research-start", "--json"]);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(receipt));
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each([401, 403, 404, 500])(
    "fails open without retrying HTTP %i",
    async (status) => {
      const requests = vi.fn(() => {
        return HttpResponse.json(
          { error: { code: "UNAVAILABLE", message: "unavailable" } },
          { status },
        );
      });
      server.use(http.post(endpoint, requests));
      await run(["research-start", "--json"]);
      expect(requests).toHaveBeenCalledTimes(1);
      expect(console.log).toHaveBeenCalledWith(
        JSON.stringify({
          schemaVersion: 2,
          status: "unavailable",
          reason: "http-error",
        }),
      );
      expect(console.error).not.toHaveBeenCalled();
      expect(process.exitCode ?? 0).toBe(0);
    },
  );

  it("aborts at its deadline and reports unknown delivery without retry", async () => {
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    const started = deferred<void>();
    const aborted = deferred<void>();
    const requests = vi.fn(async ({ request }: { request: Request }) => {
      request.signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
        },
        { once: true },
      );
      started.resolve();
      await aborted.promise;
      return new HttpResponse(null, { status: 503 });
    });
    server.use(http.post(endpoint, requests));
    const finished = run(["research-start", "--json"]);
    try {
      await started.promise;
      expect(timeout).toHaveBeenCalledWith(500);
      deadline.abort(new DOMException("Request timed out", "TimeoutError"));
      await finished;
      await aborted.promise;
    } finally {
      deadline.abort();
      timeout.mockRestore();
    }
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        schemaVersion: 2,
        status: "unavailable",
        reason: "timeout-delivery-unknown",
      }),
    );
    expect(requests).toHaveBeenCalledTimes(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("does not claim a malformed response was accepted", async () => {
    server.use(
      http.post(endpoint, () => {
        return HttpResponse.json({ status: "accepted" }, { status: 202 });
      }),
    );
    await run(["research-start", "--json"]);
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        schemaVersion: 2,
        status: "unavailable",
        reason: "invalid-response",
      }),
    );
  });

  it("fails open on a transport error without retrying", async () => {
    const requests = vi.fn(() => {
      return HttpResponse.error();
    });
    server.use(http.post(endpoint, requests));
    await run(["research-start", "--json"]);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        schemaVersion: 2,
        status: "unavailable",
        reason: "transport-error",
      }),
    );
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });
});
