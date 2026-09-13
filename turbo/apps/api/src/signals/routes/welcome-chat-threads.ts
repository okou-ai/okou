import { command } from "ccstate";
import { welcomeChatThreadsContract } from "@okouai/api-contracts/contracts/welcome-chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import { createWelcomeChatThread$ } from "../services/welcome-chat-thread.service";

const createBody$ = bodyResultOf(welcomeChatThreadsContract.create);

const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(createBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    createWelcomeChatThread$,
    { orgId: auth.orgId, userId: auth.userId, ...body.data },
    signal,
  );
  signal.throwIfAborted();
  if (result.status === 201) {
    // Publish only after commit. A lost notification is recovered by the
    // client's ordinary thread-list and history synchronization.
    await publishThreadListChanged(auth);
    signal.throwIfAborted();
    await publishChatThreadMessageCreatedSafely({
      ...auth,
      threadId: result.body.id,
      syncThroughSeqId: 1,
    });
    signal.throwIfAborted();
  }
  return result;
});

export const welcomeChatThreadRoutes: readonly RouteEntry[] = [
  {
    route: welcomeChatThreadsContract.create,
    handler: authRoute(
      {
        requiredCapability: "chat-thread:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      create$,
    ),
  },
];
