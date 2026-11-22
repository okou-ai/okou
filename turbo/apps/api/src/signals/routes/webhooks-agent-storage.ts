import { command } from "ccstate";
import {
  runWebhookContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
} from "@okouai/api-contracts/contracts/webhooks";

import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  commitMemberMemoryWriteback$,
  prepareMemberMemoryWriteback$,
} from "../services/storage-write.service";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const prepareBody$ = bodyResultOf(webhookStoragesPrepareContract.prepare);
const commitBody$ = bodyResultOf(webhookStoragesCommitContract.commit);

const prepareStorage$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(prepareBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }
  return await set(
    prepareMemberMemoryWriteback$,
    {
      ...body,
      auth,
    },
    signal,
  );
});

const commitStorage$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(commitBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }
  return await set(
    commitMemberMemoryWriteback$,
    {
      ...body,
      auth,
    },
    signal,
  );
});

export const webhooksAgentStorageRoutes: readonly RouteEntry[] = [
  {
    route: webhookStoragesPrepareContract.prepare,
    handler: prepareStorage$,
  },
  {
    route: runWebhookContract.storagePrepare,
    handler: prepareStorage$,
  },
  {
    route: webhookStoragesCommitContract.commit,
    handler: commitStorage$,
  },
  {
    route: runWebhookContract.storageCommit,
    handler: commitStorage$,
  },
];
