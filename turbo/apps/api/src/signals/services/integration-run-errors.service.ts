import { formatRunErrorForExternalSurface } from "@okouai/api-contracts/contracts/errors";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

function addCreditsUrl(): string {
  const appUrl = env("APP_URL");
  return `${appUrl}/?settings=billing&billingView=credits`;
}

function comparePlansUrl(): string {
  const appUrl = env("APP_URL");
  return `${appUrl}/?settings=billing&billingView=plans`;
}

export const formatIntegrationRunError$ = command(
  async (
    { get, set },
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

    const db = get(db$);
    const [membership, capabilities] = await Promise.all([
      set(getMemberRoleAndUpdateCache$, args.orgId, args.userId, signal),
      loadOrgPlanCapabilities(db, args.orgId),
    ]);
    signal.throwIfAborted();

    const canBuyCredits = capabilities?.canBuyCredits === true;
    return formatRunErrorForExternalSurface({
      code: args.code,
      message: args.message,
      insufficientCredits: {
        canManageBilling:
          membership.kind === "member" && membership.role === "admin",
        ...(canBuyCredits
          ? { addCreditsUrl: addCreditsUrl() }
          : { comparePlansUrl: comparePlansUrl() }),
      },
    });
  },
);
