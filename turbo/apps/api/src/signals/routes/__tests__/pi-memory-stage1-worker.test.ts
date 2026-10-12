import { cronExtractPiMemoryStage1Contract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cronExtractPiMemoryStage1Routes } from "../cron-extract-pi-memory-stage1";
import { createBddApi } from "./helpers/api-bdd";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";

const context = testContext();

describe("Pi memory public boundaries", () => {
  it("authenticates the production cron route before the disabled breaker", async () => {
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "false");
    mockEnv("CRON_SECRET", "test-pi-memory-stage1-secret");
    context.mocks.s3.send.mockClear();
    const response = await accept(
      setupApp({ context, routes: cronExtractPiMemoryStage1Routes })(
        cronExtractPiMemoryStage1Contract,
      ).extract({ headers: { authorization: "Bearer invalid-secret" } }),
      [401],
    );
    expect(response.status).toBe(401);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("exposes only fixed Auto as a platform chat route", async () => {
    const actor = createBddApi(context).user();
    const models = await createMiscRoutesApi(context).listRunModels(actor);
    expect(
      models.models
        .filter((model) => {
          return model.memberEffective.providerType === "built-in";
        })
        .map(({ model }) => {
          return model;
        }),
    ).toStrictEqual(["auto"]);
  });
});
