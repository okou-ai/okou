import { command, computed } from "ccstate";
import {
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
} from "@okouai/api-contracts/contracts/webhooks";

import { notFound } from "../../lib/error";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  createAgentCheckpointOperations,
  prepareCheckpointHistoryUpload$,
} from "../services/agent-webhook-checkpoints.service";
import { settle } from "../utils";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

function createAuthorizedCheckpoint(runId: string) {
  return computed((get) => {
    const auth = getSandboxAuthForRun(runId, get(authorization$));
    if (!auth) {
      return null;
    }
    return {
      auth,
      checkpoint: createAgentCheckpointOperations(runId, auth.userId),
    };
  });
}

const createBody$ = bodyResultOf(webhookCheckpointsContract.create);
const createRequest$ = computed(async (get) => {
  const bodyResult = await get(createBody$);
  if (!bodyResult.ok) {
    return bodyResult;
  }
  return {
    ...bodyResult,
    authorizedCheckpoint$: createAuthorizedCheckpoint(bodyResult.data.runId),
  };
});
const createCheckpoint$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(createRequest$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const authorized = get(bodyResult.authorizedCheckpoint$);
  if (!authorized) {
    return unauthorizedRunMismatch;
  }

  const result = await settle(
    set(authorized.checkpoint.create$, { auth: authorized.auth, body }, signal),
  );
  signal.throwIfAborted();

  if (!result.ok) {
    if (isForeignKeyViolation(result.error)) {
      return notFound("Agent run not found");
    }
    throw result.error;
  }

  return result.value;
});

const prepareHistoryBody$ = bodyResultOf(
  webhookCheckpointsPrepareHistoryContract.prepare,
);
const prepareHistory$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(prepareHistoryBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }

  return await set(prepareCheckpointHistoryUpload$, { auth, body }, signal);
});

export const webhooksAgentCheckpointsRoutes: readonly RouteEntry[] = [
  {
    route: webhookCheckpointsContract.create,
    handler: createCheckpoint$,
  },
  {
    route: webhookCheckpointsPrepareHistoryContract.prepare,
    handler: prepareHistory$,
  },
];
