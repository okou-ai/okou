import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { command } from "ccstate";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { chatThreadArtifacts } from "../services/chat-thread.service";
import {
  applyGoogleDriveArtifactSyncStatuses,
  googleDriveArtifactStatusLookup$,
} from "../services/google-drive-artifact-sync.service";
import { chatThreadNotFound } from "./chat-thread-not-found";

const listChatThreadArtifactsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(chatThreadArtifactsContract.list));
    const [runs, lookup] = await Promise.all([
      get(
        chatThreadArtifacts({
          threadId: params.threadId,
          userId: auth.userId,
        }),
      ),
      set(
        googleDriveArtifactStatusLookup$,
        {
          threadId: params.threadId,
          orgId: auth.orgId,
          userId: auth.userId,
        },
        signal,
      ),
    ]);
    signal.throwIfAborted();
    if (!runs) {
      return chatThreadNotFound();
    }

    return {
      status: 200 as const,
      body: { runs: applyGoogleDriveArtifactSyncStatuses(runs, lookup) },
    };
  },
);

export const chatThreadArtifactRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadArtifactsContract.list,
    handler: authRoute({}, listChatThreadArtifactsInner$),
  },
];
