import { createHash } from "node:crypto";
import type { MarketingRewardIntent } from "@okouai/api-contracts/contracts/marketing-reward-settlement";

/** UUIDv8 binds every request term; changing terms cannot reuse the same financial identity. */
export function marketingRewardIntentIdentity(
  intent: Omit<MarketingRewardIntent, "id">,
) {
  const identity = [
    intent.version,
    intent.environment,
    intent.policy,
    intent.sourceEventId.toLowerCase(),
    intent.questKey,
    intent.sourceKey,
    intent.rewardKey,
    intent.orgId,
    intent.actorUserId,
    intent.beneficiaryUserId,
    intent.rewardTarget,
    intent.rewardAmount,
    intent.completedAt,
  ];
  const bytes = createHash("sha256")
    .update("marketing:get-started-intent:v1\0")
    .update(JSON.stringify(identity))
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 15) | 128, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 63) | 128, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
