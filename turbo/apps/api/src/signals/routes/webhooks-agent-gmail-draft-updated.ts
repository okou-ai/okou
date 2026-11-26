import { runWebhookContract } from "@okouai/api-contracts/contracts/webhooks";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { mailDrafts } from "@okouai/db/schema/mail-draft";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishMailDraftChangedSafely } from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const route = runWebhookContract.gmailDraftUpdated;
const body$ = bodyResultOf(route);

const notify$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId, connectionId, gmailDraftId } = body.data;
  const auth = getSandboxAuthForRun(runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }
  const [draft] = await set(writeDb$)
    .select({ id: mailDrafts.id })
    .from(mailDrafts)
    .innerJoin(chatThreads, eq(chatThreads.id, mailDrafts.chatThreadId))
    .innerJoin(agentRuns, eq(agentRuns.chatThreadId, chatThreads.id))
    .where(
      and(
        eq(agentRuns.id, auth.runId),
        eq(agentRuns.userId, auth.userId),
        eq(agentRuns.orgId, auth.orgId),
        eq(chatThreads.userId, auth.userId),
        eq(chatThreads.orgId, auth.orgId),
        eq(mailDrafts.provider, "gmail"),
        eq(mailDrafts.connectorId, connectionId),
        eq(mailDrafts.gmailDraftId, gmailDraftId),
        eq(mailDrafts.status, "draft"),
      ),
    );
  signal.throwIfAborted();
  if (draft) {
    await publishMailDraftChangedSafely(auth, draft.id);
  }
  // A Gmail draft may be edited before anyone links it to the chat.
  return { status: 204 as const, body: undefined };
});

export const webhooksAgentGmailDraftUpdatedRoutes: readonly RouteEntry[] = [
  { route, handler: notify$ },
];
