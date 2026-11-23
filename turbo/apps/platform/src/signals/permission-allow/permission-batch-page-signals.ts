import { computed } from "ccstate";
import { createPermissionBatchSignals } from "../chat-page/permission-batch-signals.ts";
import { parsePermissionBatchActionUrl } from "../chat-page/permission-batch-action-block.ts";
import { pathname, search, hash } from "../location.ts";
import { searchParams$ } from "../route.ts";

export const permissionBatchPageDescriptor$ = computed((get) => {
  const params = get(searchParams$);
  // The resource graph verifies URL claims before allowing a mutation.
  const parsed = parsePermissionBatchActionUrl(
    `${pathname()}${search()}${hash()}`,
    {
      threadId: params.get("threadId") ?? "",
    },
  );
  return parsed.status === "valid" ? parsed.descriptor : null;
});

/** The route identity owns the graph; setup only waits for and displays it. */
export const permissionBatchPageSignals$ = computed((get) => {
  const descriptor = get(permissionBatchPageDescriptor$);
  return descriptor ? createPermissionBatchSignals(descriptor) : null;
});
