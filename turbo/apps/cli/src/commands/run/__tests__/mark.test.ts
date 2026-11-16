import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { deferred } from "../../../test-fixtures/ably-realtime";
import { createRunMarkCommand } from "../mark";

const endpoint = "https://api.okou.ai/api/runs/current/phase-mark";
const receipt = {
  schemaVersion: 1,
  status: "recorded",
  reason: null,
  timing: {
    researchStartedAt: null,
    generationStartedAt: "2026-11-16T03:00:00.000Z",
    researchSkipped: true,
    generationKind: "report",
  },
};
function token(capabilities: readonly string[]) {
  return `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities, userId: "owner", orgId: "org", runId: "a0000000-0000-4000-8000-000000000001" })).toString("base64url")}.signature`;
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
  vi.stubEnv("OKOU_TOKEN", token(["run-timing:write"]));
  vi.spyOn(console, "log").mockImplementation(() => {
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementation(() => {
    return undefined;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
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
        return HttpResponse.json(receipt);
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
      return HttpResponse.json(receipt);
    });
    server.use(http.post(endpoint, requests));
    await run(["generation-start", "--kind", "report", "--skip-research"]);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("prints the server receipt without substituting the local clock", async () => {
    server.use(
      http.post(endpoint, async ({ request }) => {
        expect(await request.json()).toEqual({ phase: "research-start" });
        return HttpResponse.json(receipt);
      }),
    );
    await run(["research-start", "--json"]);
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(receipt));
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
          schemaVersion: 1,
          status: "unavailable",
          reason: "http-error",
        }),
      );
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it("aborts the request at its deadline and reports an unknown commit without retry", async () => {
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
        schemaVersion: 1,
        status: "unavailable",
        reason: "timeout-commit-unknown",
      }),
    );
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it("does not contact the API when the Run lacks the capability", async () => {
    vi.stubEnv("OKOU_TOKEN", token(["run-usage:read"]));
    const requests = vi.fn(() => {
      return HttpResponse.json(receipt);
    });
    server.use(http.post(endpoint, requests));
    await run(["research-start", "--json"]);
    expect(requests).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        schemaVersion: 1,
        status: "unavailable",
        reason: "missing-capability",
      }),
    );
  });

  it("does not claim a malformed response was recorded", async () => {
    server.use(
      http.post(endpoint, () => {
        return HttpResponse.json({ status: "recorded" });
      }),
    );
    await run(["research-start", "--json"]);
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        schemaVersion: 1,
        status: "unavailable",
        reason: "invalid-response",
      }),
    );
  });
});
