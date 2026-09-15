import { cronRenderVideoPostersContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cronRenderVideoPostersRoutes } from "../cron-render-video-posters";

const context = testContext();

function client() {
  return setupApp({ context, routes: cronRenderVideoPostersRoutes })(
    cronRenderVideoPostersContract,
  );
}

describe("video poster backfill cron", () => {
  it("rejects a request without the cron secret", async () => {
    const response = await client().render({
      headers: { authorization: "Bearer wrong-secret" },
    });
    expect(response.status).toBe(401);
  });

  it("reserves each eligible video once per retry interval", async () => {
    const headers = { authorization: "Bearer test-cron-secret" } as const;
    const first = await client().render({ headers });
    expect(first.status).toBe(200);
    // Whatever the first tick reserved, an immediate second tick must skip it,
    // so one undecodable video cannot hold a slot on every tick.
    const second = await client().render({ headers });
    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      reserved: 0,
      rendered: 0,
    });
  });
});
