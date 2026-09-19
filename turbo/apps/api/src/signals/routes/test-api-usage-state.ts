import {
  testApiUsageStateContract,
  type TestApiUsageStateActionBody,
} from "@okouai/api-contracts/contracts/test-api-usage-state";
import { initialAgentRunApiUsageProjection } from "@okouai/db/jsonb-contracts/agent-run-api-usage";
import { agentRunApiUsage } from "@okouai/db/schema/agent-run-api-usage";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  recordPiApiUsageObservation,
  registerPiApiUsageAttempt,
} from "../services/pi-api-usage-observation.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

type TestApiUsageStateAction<
  TAction extends TestApiUsageStateActionBody["action"],
> = Extract<TestApiUsageStateActionBody, { action: TAction }>;

async function initialize(
  db: Db,
  body: TestApiUsageStateAction<"initialize">,
  signal: AbortSignal,
) {
  await db.insert(agentRunApiUsage).values({
    runId: body.runId,
    revision: 1,
    projection: initialAgentRunApiUsageProjection(body.phase),
    updatedAt: nowDate(),
  });
  signal.throwIfAborted();
  return { status: 200 as const, body: { ok: true as const } };
}

const mutateApiUsageState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(
      bodyResultOf(testApiUsageStateContract.action),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const db = set(writeDb$);
    switch (bodyResult.data.action) {
      case "initialize": {
        return await initialize(db, bodyResult.data, signal);
      }
      case "register": {
        await registerPiApiUsageAttempt(db, bodyResult.data);
        signal.throwIfAborted();
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "observe": {
        await recordPiApiUsageObservation(db, {
          ...bodyResult.data,
          observation: bodyResult.data.observation ?? undefined,
        });
        signal.throwIfAborted();
        return { status: 200 as const, body: { ok: true as const } };
      }
    }
  },
);

export const testApiUsageStateRoutes: readonly RouteEntry[] = [
  {
    route: testApiUsageStateContract.action,
    handler: mutateApiUsageState$,
  },
];
