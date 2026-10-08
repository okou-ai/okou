import { command, computed } from "ccstate";
import type { z } from "zod";
import {
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
} from "@okouai/api-contracts/contracts/webhooks";

import type { AuthContext } from "../../types/auth";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  createSandboxStorageCommit,
  prepareStorageUploadForAuth$,
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
    prepareStorageUploadForAuth$,
    {
      auth: {
        tokenType: "sandbox",
        userId: auth.userId,
        orgId: auth.orgId,
        runId: auth.runId,
      },
      ...body,
    },
    signal,
  );
});

function createAuthorizedStorageCommit(
  body: z.infer<typeof webhookStoragesCommitContract.commit.body>,
) {
  return computed((get) => {
    const auth = getSandboxAuthForRun(body.runId, get(authorization$));
    if (!auth) {
      return null;
    }
    const commitInput = {
      auth: {
        tokenType: "sandbox",
        userId: auth.userId,
        orgId: auth.orgId,
        runId: auth.runId,
      },
      ...body,
    } satisfies {
      auth: Extract<AuthContext, { tokenType: "sandbox" }>;
    } & z.infer<typeof webhookStoragesCommitContract.commit.body>;
    return createSandboxStorageCommit(commitInput);
  });
}

const commitRequest$ = computed(async (get) => {
  const bodyResult = await get(commitBody$);
  if (!bodyResult.ok) {
    return bodyResult;
  }
  return {
    ...bodyResult,
    authorizedCommit$: createAuthorizedStorageCommit(bodyResult.data),
  };
});

const commitStorage$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(commitRequest$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const authorized = get(bodyResult.authorizedCommit$);
  if (!authorized) {
    return unauthorizedRunMismatch;
  }
  return await set(authorized.commit$, signal);
});

export const webhooksAgentStorageRoutes: readonly RouteEntry[] = [
  {
    route: webhookStoragesPrepareContract.prepare,
    handler: prepareStorage$,
  },
  {
    route: webhookStoragesCommitContract.commit,
    handler: commitStorage$,
  },
];
