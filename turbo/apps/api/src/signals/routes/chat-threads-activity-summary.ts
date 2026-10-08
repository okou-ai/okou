import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { command } from "ccstate";
import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { requestActivitySummary } from "../services/chat-activity-summary.service";

const body$ = bodyResultOf(chatThreadActivitySummaryContract.summarize);
const summarize$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadActivitySummaryContract.summarize));
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  set(setResHeader$, "Cache-Control", "no-store");
  const result = await requestActivitySummary(
    set(writeDb$),
    {
      threadId: params.id,
      runId: body.data.runId,
      userId: auth.userId,
      orgId: auth.orgId,
    },
    signal,
  );
  if (result.kind === "not-found") {
    return notFound("Chat run not found");
  }
  return { status: 200 as const, body: result.response };
});
export const chatThreadActivitySummaryRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadActivitySummaryContract.summarize,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      summarize$,
    ),
  },
];
