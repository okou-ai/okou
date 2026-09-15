import { command } from "ccstate";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { invalidateOrgModelPolicies$ } from "./org-model-policies.ts";

/**
 * Only invalidate the cheap local routing projection. Listing subscriptions
 * here would read upstream usage for every notice and connection resync.
 */
export const setupModelPolicyRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await Promise.all(
      (["user", "org"] as const).map((scope) => {
        return set(
          setAblyInvalidationLoop$,
          {
            scope,
            topic: "modelPoliciesChanged",
            invalidations: [invalidateOrgModelPolicies$],
            options: { runOnSubscribe: true },
          },
          signal,
        );
      }),
    );
  },
);
