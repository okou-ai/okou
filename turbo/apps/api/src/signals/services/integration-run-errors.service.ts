import {
  formatRunErrorForExternalSurface,
  INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE,
} from "@okouai/api-contracts/contracts/errors";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";

export const formatIntegrationRunError$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly code: string;
      readonly message: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    if (args.code !== "INSUFFICIENT_CREDITS") {
      return formatRunErrorForExternalSurface({
        code: args.code,
        message: args.message,
      });
    }

    const membership = await set(
      getMemberRoleAndUpdateCache$,
      args.orgId,
      args.userId,
      signal,
    );
    if (membership.kind !== "member" || membership.role !== "admin") {
      return INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE;
    }
    const capabilities = await set(
      loadOrgPlanCapabilities$,
      args.orgId,
      signal,
    );
    const appUrl = env("APP_URL");
    if (capabilities?.planKey === "limited-free-1") {
      return `Insufficient credits. Upgrade to Pro to continue.\n\nUpgrade to Pro: ${appUrl}/?settings=billing&billingView=plans`;
    }
    return `Insufficient credits. Add credits to continue.\n\nBilling: ${appUrl}/?settings=billing`;
  },
);

/** Keep Web's recovery marker in the event and render guidance at delivery. */
export const formatIntegrationChatMessage$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly content: string;
      readonly error: string | null;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    if (args.error !== "insufficient_credits") {
      return args.content;
    }
    return await set(
      formatIntegrationRunError$,
      {
        orgId: args.orgId,
        userId: args.userId,
        code: "INSUFFICIENT_CREDITS",
        message: args.content,
      },
      signal,
    );
  },
);
