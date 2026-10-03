import { publishOrgSignal, publishUserSignal } from "../external/realtime";
import { waitUntil } from "../context/wait-until";
import { bestEffort } from "../utils";

/** Metadata changed. Never carries credentials, provider inventory or host references. */
export function publishTailscaleClientInvalidation(
  owner: { readonly orgId: string; readonly userId: string },
  scope: "personal" | "organization" = "personal",
): Promise<void> {
  if (scope === "organization") {
    waitUntil(
      bestEffort(
        publishOrgSignal(owner.orgId, "tailscale:changed", {
          orgId: owner.orgId,
        }),
      ),
    );
    return Promise.resolve();
  }
  return publishUserSignal([owner.userId], "tailscale:changed", {
    orgId: owner.orgId,
  });
}
