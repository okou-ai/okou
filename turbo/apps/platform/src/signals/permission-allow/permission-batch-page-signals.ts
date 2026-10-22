import { computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createPermissionBatchSignals } from "../chat-page/permission-batch-signals.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { parsePermissionBatchActionUrl } from "../chat-page/permission-batch-action-block.ts";
import { pathname, search, hash } from "../location.ts";
import { pathParams$, searchParams$ } from "../route.ts";

export const permissionBatchPageDescriptor$ = computed((get) => {
  const agentId = get(pathParams$)?.agentId;
  const params = get(searchParams$);
  if (typeof agentId !== "string") {
    return null;
  }
  // Standalone route IDs are claims. The resource graph verifies the agent
  // and callback thread through authoritative APIs before allowing a mutation.
  const parsed = parsePermissionBatchActionUrl(
    `${pathname()}${search()}${hash()}`,
    {
      agentId,
      threadId: params.get("threadId") ?? "",
    },
  );
  return parsed.status === "valid" ? parsed.descriptor : null;
});

/** The route identity owns the graph; setup only waits for and displays it. */
export const permissionBatchPageSignals$ = computed(async (get) => {
  const descriptor = get(permissionBatchPageDescriptor$);
  const features = await get(featureSwitch$);
  return descriptor && features[FeatureSwitchKey.BatchConnectorPermissions]
    ? createPermissionBatchSignals(descriptor)
    : null;
});
