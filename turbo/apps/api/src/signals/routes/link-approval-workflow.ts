import { command } from "ccstate";
import { linkApprovalWorkflowContract } from "@okouai/api-contracts/contracts/link-approval-workflow";
import { env } from "../../lib/env";
import { verifyLinkApprovalSignature } from "../../lib/link-approval-verification";
import { request$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { safeJsonParse } from "../utils";
import { pollLinkApproval$ } from "../services/link-approval-workflow.service";

const poll$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  const raw = await request.text();
  signal.throwIfAborted();
  const secret = env("LINK_APPROVAL_WORKER_SECRET");
  if (
    raw.length > 1024 ||
    !secret ||
    !verifyLinkApprovalSignature(
      secret,
      request.raw.headers.get("x-link-approval-timestamp"),
      request.raw.headers.get("x-link-approval-signature"),
      raw,
    )
  ) {
    return Response.json(
      { error: "Invalid approval Worker request" },
      { status: 401 },
    );
  }
  const parsed = linkApprovalWorkflowContract.poll.body.safeParse(
    safeJsonParse(raw),
  );
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid approval request" },
      { status: 400 },
    );
  }
  const body = await set(pollLinkApproval$, parsed.data.spendId, signal);
  signal.throwIfAborted();
  return { status: 200 as const, body };
});

export const linkApprovalWorkflowRoutes: readonly RouteEntry[] = [
  { route: linkApprovalWorkflowContract.poll, handler: poll$ },
];
