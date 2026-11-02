import { accept } from "@okouai/connectors/accept";
import type { LinkApprovalWorkflowParams } from "@okouai/api-contracts/contracts/link-approval-workflow";
import { env } from "../../lib/env";

export function isLinkApprovalConfigured() {
  return Boolean(
    env("LINK_APPROVAL_WORKER_URL") &&
    env("LINK_APPROVAL_WORKER_SECRET") &&
    env("LINK_APPROVAL_CONTROL_SECRET"),
  );
}

export async function startLinkApprovalWorkflow(
  params: LinkApprovalWorkflowParams,
  _signal: AbortSignal,
) {
  const origin = env("LINK_APPROVAL_WORKER_URL");
  const secret = env("LINK_APPROVAL_CONTROL_SECRET");
  if (!origin || !secret) {
    throw new Error("Link approval Worker is not configured");
  }
  const url = new URL("/start", origin);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Link approval Worker must use HTTPS");
  }
  await accept(
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(params),
    }),
    [200],
  );
}
