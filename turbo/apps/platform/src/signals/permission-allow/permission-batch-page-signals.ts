import { command, computed, state } from "ccstate";
import type { PermissionBatchSignals } from "../chat-page/permission-batch-signals.ts";
import { parsePermissionBatchActionUrl } from "../chat-page/permission-batch-action-block.ts";
import { pathname, search, hash } from "../location.ts";
import { pathParams$, searchParams$ } from "../route.ts";

/** Installed once by the route setup command; never constructed by a read/render. */
const internalPermissionBatchPageSignals$ =
  state<PermissionBatchSignals | null>(null);

export const permissionBatchPageSignals$ = computed((get) => {
  return get(internalPermissionBatchPageSignals$);
});

export const setPermissionBatchPageSignals$ = command(
  ({ set }, signals: PermissionBatchSignals | null) => {
    set(internalPermissionBatchPageSignals$, signals);
  },
);

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
