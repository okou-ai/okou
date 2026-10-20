import {
  cronConsolidatePiMemoryPhase2Contract,
  cronExtractPiMemoryStage1Contract,
} from "@okouai/api-contracts/contracts/cron";
import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cronConsolidatePiMemoryPhase2Routes } from "../cron-consolidate-pi-memory-phase2";
import { cronExtractPiMemoryStage1Routes } from "../cron-extract-pi-memory-stage1";

const context = testContext();

test("rejects extraction without the operator credential", async () => {
  const app = await setupApp({
    context,
    routes: cronExtractPiMemoryStage1Routes,
  });
  const client = app(cronExtractPiMemoryStage1Contract);
  const response = await client.extract({
    headers: { authorization: "Bearer wrong-secret" },
  });
  expect(response.status).toBe(401);
});

test("rejects consolidation without the operator credential", async () => {
  const app = await setupApp({
    context,
    routes: cronConsolidatePiMemoryPhase2Routes,
  });
  const client = app(cronConsolidatePiMemoryPhase2Contract);
  const response = await client.consolidate({
    headers: { authorization: "Bearer wrong-secret" },
  });
  expect(response.status).toBe(401);
});
