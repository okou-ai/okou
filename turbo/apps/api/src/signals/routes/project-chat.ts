import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { projectChatContract } from "@okouai/api-contracts/contracts/project-chat";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import { projectAccess$ } from "./projects";
import { sendValidatedChatEvent$ } from "./chat-events";
import {
  chatThreadDraft,
  updateChatThreadDraft$,
} from "../services/chat-thread.service";
import { chatThreadOrganizationPredicate } from "../services/chat-thread-organization.service";
import { notFound, resourceUnavailable } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const missing = notFound("Project or conversation not found");
function ownedThread(id: string) {
  return computed(async (get) => {
    const owner = get(organizationAuthContext$);
    if (
      owner.tokenType === "agent" &&
      !owner.capabilities.includes("project:read")
    ) {
      return resourceUnavailable("Project access is not available");
    }
    const rows = await get(db$)
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, id),
          eq(chatThreads.userId, owner.userId),
          chatThreadOrganizationPredicate(owner.orgId),
        ),
      );
    return rows.length > 0;
  });
}
const send$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(projectAccess$))) {
    return missing;
  }
  const body = await get(bodyResultOf(projectChatContract.send));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(sendValidatedChatEvent$, body.data, signal);
});
const draft$ = computed(async (get) => {
  if (!(await get(projectAccess$))) {
    return missing;
  }
  const id = get(pathParamsOf(projectChatContract.draft)).id;
  if (!(await get(ownedThread(id)))) {
    return missing;
  }
  return {
    status: 200 as const,
    body: await get(
      chatThreadDraft({
        threadId: id,
        userId: get(organizationAuthContext$).userId,
      }),
    ),
  };
});
const saveDraft$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(projectAccess$))) {
    return missing;
  }
  const id = get(pathParamsOf(projectChatContract.saveDraft)).id;
  if (!(await get(ownedThread(id)))) {
    return missing;
  }
  const body = await get(bodyResultOf(projectChatContract.saveDraft));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  await set(
    updateChatThreadDraft$,
    {
      threadId: id,
      userId: get(organizationAuthContext$).userId,
      ...body.data,
    },
    signal,
  );
  return { status: 204 as const, body: undefined };
});
export const projectChatRoutes: readonly RouteEntry[] = [
  {
    route: projectChatContract.send,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "chat-event:write",
        oauthScope: "okou:chat:send",
      },
      send$,
    ),
  },
  {
    route: projectChatContract.draft,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "chat-thread:read" },
      draft$,
    ),
  },
  {
    route: projectChatContract.saveDraft,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "chat-thread:write" },
      saveDraft$,
    ),
  },
];
