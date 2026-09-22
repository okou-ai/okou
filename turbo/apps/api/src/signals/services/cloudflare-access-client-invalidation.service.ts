import { publishUserSignal } from "../external/realtime";

import { publishSshClientInvalidation } from "./ssh-client-invalidation.service";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

function publishCloudflareAccessChanged(owner: Owner): Promise<void> {
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
): Promise<void> {
  return publishCloudflareAccessMutationInvalidation(owner, () => {
    return publishSshClientInvalidation(owner);
  });
}
