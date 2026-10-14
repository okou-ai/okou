import { chatInputStatusContract } from "@okouai/api-contracts/contracts/chat-input-status";
import { command, computed } from "ccstate";
import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { chatInputStatus } from "../services/chat-input-status.service";

const identity$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return Promise.resolve({
    userId: auth.userId,
    orgId: auth.orgId,
    ...get(pathParamsOf(chatInputStatusContract.get)),
  });
});
const observation$ = chatInputStatus(identity$);

const readInputStatus$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const result = await get(observation$);
  signal.throwIfAborted();
  if (result.kind === "thread-not-found") {
    return notFound("Chat thread not found");
  }
  if (result.kind === "invalid-input") {
    return badRequestMessage("Use the original accepted input event ID");
  }
  return { status: 200 as const, body: result.response };
});

export const chatInputStatusRoutes: readonly RouteEntry[] = [
  {
    route: chatInputStatusContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
        oauthScope: "okou:chat:read",
      },
      readInputStatus$,
    ),
  },
];
