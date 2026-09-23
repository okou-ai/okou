import { publishOrgSignal, publishUserSignal } from "../external/realtime";
import { waitUntil } from "../context/wait-until";
import { bestEffort } from "../utils";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

function publishCloudflareAccessChanged(
  owner: Owner,
  scope: "personal" | "organization" = "personal",
): Promise<void> {
  if (scope === "organization") {
    waitUntil(
      bestEffort(
        publishOrgSignal(owner.orgId, "cloudflare-access:changed", {
          orgId: owner.orgId,
        }),
      ),
    );
    return Promise.resolve();
  }
  return publishUserSignal([owner.userId], "cloudflare-access:changed", {
    orgId: owner.orgId,
  });
}

export async function publishCloudflareAccessMutationInvalidation(
  owner: Owner,
  publishSshInvalidation: () => Promise<void>,
): Promise<void> {
  await Promise.all([
    publishCloudflareAccessChanged(owner),
    publishSshInvalidation(),
  ]);
}

export function publishCloudflareAccessClientInvalidation(
  owner: Owner,
  scope: "personal" | "organization" = "personal",
): Promise<void> {
  return publishCloudflareAccessChanged(owner, scope);
}
