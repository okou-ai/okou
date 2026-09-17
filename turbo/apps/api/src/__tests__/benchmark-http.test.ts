import { HttpResponse, http } from "msw";

import { server } from "../mocks/server";
import { createBenchHttpHandlers } from "../signals/routes/__benches__/helpers/http";
import { testContext } from "./test-context";

const context = testContext();

// These test-owned HTTP fixtures have no production endpoint. Fetch responses
// are their external interface; API metadata consumption is checked by the bench.
describe("benchmark HTTP fixtures", () => {
  it("preserves another registered handler outside R2", async () => {
    server.use(
      http.get("https://fixture.example.test/status", () => {
        return HttpResponse.json({ source: "existing handler" });
      }),
    );
    server.use(...createBenchHttpHandlers());

    const response = await fetch("https://fixture.example.test/status", {
      signal: context.signal,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      source: "existing handler",
    });
  });

  it.each([
    "https://test-account.r2.cloudflarestorage.com/test-user-artifacts",
    "https://test-user-artifacts.test-account.r2.cloudflarestorage.com/",
  ])("lists benchmark R2 objects at %s", async (url) => {
    server.use(...createBenchHttpHandlers());

    const response = await fetch(`${url}?list-type=2&prefix=attachments/`, {
      signal: context.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("xml");
    await expect(response.text()).resolves.toContain(
      "<Key>attachments/bench-attachment.md</Key>",
    );
  });

  it("rejects unsupported R2 buckets", async () => {
    server.use(...createBenchHttpHandlers());

    const response = await fetch(
      "https://test-account.r2.cloudflarestorage.com/unknown?list-type=2",
      { signal: context.signal },
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("not found");
  });

  it("keeps unexpected non-R2 requests subject to the MSW error policy", async () => {
    server.use(...createBenchHttpHandlers());

    await expect(
      fetch("https://unexpected.example.test/unmocked", {
        signal: context.signal,
      }),
    ).rejects.toThrow("onUnhandledRequest");
  });
});
