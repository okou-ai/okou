import { setTimeout } from "node:timers/promises";
import {
  linkApprovalPollResultSchema,
  type LinkApprovalWorkflowParams,
} from "@okouai/api-contracts/contracts/link-approval-workflow";
import { signature } from "./auth";

export interface Env {
  readonly LINK_APPROVAL_ENABLED: string;
  readonly LINK_APPROVAL_API_ORIGIN: string;
  readonly LINK_APPROVAL_WORKER_SECRET: string;
  readonly LINK_APPROVAL_CONTROL_SECRET: string;
  readonly LINK_APPROVAL_WORKFLOW: Workflow<LinkApprovalWorkflowParams>;
}

export const FINAL_CHECK_GRACE_MS = 120_000;

/** Short API requests; Link credentials and card data never enter a Workflow. */
export async function pollApproval(env: Env, spendId: string) {
  if (env.LINK_APPROVAL_ENABLED !== "true") return { state: "done" as const };
  const url = new URL(
    "/api/internal/link-approval/poll",
    env.LINK_APPROVAL_API_ORIGIN,
  );
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Link approval API must use HTTPS");
  const body = JSON.stringify({ spendId });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      "x-link-approval-timestamp": timestamp,
      "x-link-approval-signature": await signature(
        env.LINK_APPROVAL_WORKER_SECRET,
        `${timestamp}.${body}`,
      ),
    },
    body,
  });
  if (!response.ok)
    throw new Error(`Link approval poll failed: ${response.status}`);
  return linkApprovalPollResultSchema.parse(await response.json());
}

/** One durable step holds up to a minute of ordinary, unbilled I/O waits. */
export async function pollApprovalBlock(
  env: Env,
  params: LinkApprovalWorkflowParams,
) {
  const deadline = Date.parse(params.deadline);
  const blockEnd = Math.min(Date.now() + 60_000, deadline);
  while (Date.now() < blockEnd) {
    const nextPollAt = Date.now() + 5_000;
    const result = await pollApproval(env, params.spendId);
    if (result.state === "done") return true;
    const delay = Math.min(nextPollAt, blockEnd) - Date.now();
    if (delay > 0) await setTimeout(delay);
  }
  return false;
}
