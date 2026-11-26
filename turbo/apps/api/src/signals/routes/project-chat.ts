import { command, computed } from "ccstate";
import { projectChatContract } from "@okouai/api-contracts/contracts/project-chat";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { personalProjectAccess$ } from "./projects";
import { sendValidatedChatEvent$ } from "./chat-events";
import {
  chatThreadDraft,
  updateChatThreadDraft$,
} from "../services/chat-thread.service";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const missing = notFound("Project or conversation not found");
const send$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(personalProjectAccess$)) {
    return missing;
  }
  const body = await get(bodyResultOf(projectChatContract.send));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(sendValidatedChatEvent$, { data: body.data }, signal);
});
const draft$ = computed(async (get) => {
  if (!get(personalProjectAccess$)) {
    return missing;
  }
  const id = get(pathParamsOf(projectChatContract.draft)).id;
  const draft = await get(
    chatThreadDraft({
      threadId: id,
      orgId: get(organizationAuthContext$).orgId,
      userId: get(organizationAuthContext$).userId,
    }),
  );
  if (!draft) {
    return missing;
  }
  return { status: 200 as const, body: draft };
});
const saveDraft$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(personalProjectAccess$)) {
    return missing;
  }
  const id = get(pathParamsOf(projectChatContract.saveDraft)).id;
  const body = await get(bodyResultOf(projectChatContract.saveDraft));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const saved = await set(
    updateChatThreadDraft$,
    {
      threadId: id,
      orgId: get(organizationAuthContext$).orgId,
      userId: get(organizationAuthContext$).userId,
      ...body.data,
    },
    signal,
  );
  if (!saved) {
    return missing;
  }
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
