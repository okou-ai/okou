import { command } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { LinkApprovalWorkflowParams } from "@okouai/api-contracts/contracts/link-approval-workflow";
import { env } from "../../lib/env";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

export const linkApprovalEnabled$ = command(
  async (
    { set },
    owner: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    if (
      !env("LINK_APPROVAL_WORKER_URL") ||
      !env("LINK_APPROVAL_WORKER_SECRET") ||
      !env("LINK_APPROVAL_CONTROL_SECRET")
    ) {
      return false;
    }
    const context = await set(
      loadUserFeatureSwitchContext$,
      owner.orgId,
      owner.userId,
      signal,
    );
    signal.throwIfAborted();
    return isFeatureEnabled(
      FeatureSwitchKey.LinkWalletApprovalContinuation,
      context,
    );
  },
);

export async function startLinkApprovalWorkflow(
  params: LinkApprovalWorkflowParams,
  signal: AbortSignal,
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
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Link approval Workflow start failed: ${response.status}`);
  }
}
