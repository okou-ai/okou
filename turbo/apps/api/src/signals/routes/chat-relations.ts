import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { resourceUnavailable, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  chatCommunications$,
  chatRelationMessages$,
  createdChatRelations$,
} from "../services/chat-relations.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";

const authorize$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const features = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    if (!isFeatureEnabled(FeatureSwitchKey.ChatResourcePanel, features)) {
      return resourceUnavailable("Chat relationships are not available");
    }
    const [thread] = await get(db$)
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.userId, auth.userId),
          eq(agents.orgId, auth.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      return notFound("Chat thread not found");
    }
    set(setResHeader$, "Cache-Control", "private, no-store");
    return null;
  },
);
const children$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { id } = get(pathParamsOf(chatRelationsContract.children));
  const error = await set(authorize$, id, signal);
  if (error) {
    return error;
  }
  const auth = get(organizationAuthContext$);
  return {
    status: 200 as const,
    body: await set(createdChatRelations$, { ...auth, threadId: id }, signal),
  };
});
const communications$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { id } = get(pathParamsOf(chatRelationsContract.communications));
  const error = await set(authorize$, id, signal);
  if (error) {
    return error;
  }
  const auth = get(organizationAuthContext$);
  return {
    status: 200 as const,
    body: await set(chatCommunications$, { ...auth, threadId: id }, signal),
  };
});
const messages$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { id, peerId } = get(pathParamsOf(chatRelationsContract.messages));
  const error = await set(authorize$, id, signal);
  if (error) {
    return error;
  }
  const auth = get(organizationAuthContext$);
  return {
    status: 200 as const,
    body: await set(
      chatRelationMessages$,
      { ...auth, threadId: id },
      peerId,
      signal,
    ),
  };
});
const options = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "chat-event:read",
  oauthScope: "okou:chat:read",
} as const;
export const chatRelationsRoutes: readonly RouteEntry[] = [
  {
    route: chatRelationsContract.children,
    handler: authRoute(options, children$),
  },
  {
    route: chatRelationsContract.communications,
    handler: authRoute(options, communications$),
  },
  {
    route: chatRelationsContract.messages,
    handler: authRoute(options, messages$),
  },
];
