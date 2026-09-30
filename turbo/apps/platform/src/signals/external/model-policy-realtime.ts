import { command } from "ccstate";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { invalidateModelCatalog$ } from "./model-catalog.ts";
import { invalidateOrgModelPolicies$ } from "./org-model-policies.ts";

/**
 * Only invalidate the cheap local routing projection and the global model
 * catalog (operator catalog changes are announced with the policy change). Listing subscriptions
 * here would read upstream usage for every notice and connection resync.
 */
export const setupModelPolicyRealtime$ = command(
  ({ set }, signal: AbortSignal): void => {
    for (const scope of ["user", "org"] as const) {
      set(
        setAblyInvalidationLoop$,
        {
          scope,
          topic: "modelPoliciesChanged",
          invalidations: [invalidateOrgModelPolicies$, invalidateModelCatalog$],
        },
        signal,
      );
    }
  },
);
