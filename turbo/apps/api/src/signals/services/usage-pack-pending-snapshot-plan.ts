import type {
  CreateUsagePackCheckoutSessionArgs,
  UsagePackContext,
} from "./usage-pack-subscription.service";
import type { usagePackAllocations } from "@okouai/db/schema/usage-pack-subscription";
export class UsagePackPendingSnapshotConflict extends Error {}
export function usagePackCheckoutAllocationsMatch(
  current: readonly (typeof usagePackAllocations.$inferSelect)[],
  requested: readonly CreateUsagePackCheckoutSessionArgs["allocations"][number][],
): boolean {
  return (
    current.length === requested.length &&
    requested.every((candidate) => {
      return current.some((allocation) => {
        const sameOwner =
          "userId" in candidate
            ? allocation.userId === candidate.userId &&
              allocation.invitationId === null
            : allocation.invitationId === candidate.invitationId &&
              allocation.userId === null;
        return (
          sameOwner &&
          allocation.status === "pending_payment" &&
          allocation.usagePackUsd === candidate.usagePackUsd &&
          allocation.stripePriceId === candidate.stripePriceId
        );
      });
    })
  );
}
export function usagePackCheckoutConfigurationMatches(
  args: CreateUsagePackCheckoutSessionArgs,
  customerId: string,
  context: UsagePackContext,
): boolean {
  return (
    context.subscription.tier === args.tier &&
    context.subscription.stripePlanPriceId === args.planPriceId &&
    context.subscription.stripeCustomerId === customerId &&
    usagePackCheckoutAllocationsMatch(context.allocations, args.allocations)
  );
}
export function pendingUsagePackCheckoutFingerprint(
  contexts: readonly UsagePackContext[],
): string {
  return JSON.stringify(
    [...contexts]
      .map(({ subscription, allocations }) => {
        return {
          subscription,
          allocations: [...allocations].sort((left, right) => {
            return left.id.localeCompare(right.id);
          }),
        };
      })
      .sort((left, right) => {
        return left.subscription.id.localeCompare(right.subscription.id);
      }),
  );
}
