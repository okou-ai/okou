import { chatThreadUsageContract } from "@okouai/api-contracts/contracts/chat-threads";
import { command } from "ccstate";
import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { readChatThreadUsage$ } from "../services/chat-run-usage.service";

const body$ = bodyResultOf(chatThreadUsageContract.read);
const readUsage$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { id } = get(pathParamsOf(chatThreadUsageContract.read));
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  set(setResHeader$, "Cache-Control", "no-store");
  const result = await set(
    readChatThreadUsage$,
    {
      threadId: id,
      orgId: auth.orgId,
      userId: auth.userId,
      runIds: body.data.runIds,
    },
    signal,
  );
  return result === null
    ? notFound("Chat thread not found")
    : { status: 200 as const, body: result };
});

export const chatThreadUsageRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadUsageContract.read,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      readUsage$,
    ),
  },
];
