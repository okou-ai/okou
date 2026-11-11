import { command, computed } from "ccstate";
import { delay } from "signal-timers";
import { workflowAutomationsContract } from "@okouai/api-contracts/client/workflows";
import { accept } from "../../lib/accept.ts";
import { automationNotificationDestination } from "../../lib/automation-notification-location.ts";
import { apiClient$ } from "../api-client.ts";
import { clerk$, currentOrgInfo$ } from "../auth.ts";
import { pathname$, searchParams$ } from "../route.ts";
import { pageVersion$ } from "../page-signal.ts";
import { onRef } from "../utils.ts";
import { workflowReloadVersion$ } from "./workflow-reload.ts";
import { currentWorkflowDetail$ } from "./workflows-signals.ts";

export const revealAutomationNotificationLoadingRef$ = onRef(
  command(async (_context, element: HTMLElement, signal: AbortSignal) => {
    element.hidden = true;
    await delay(200, { signal });
    signal.throwIfAborted();
    element.hidden = false;
  }),
);

export const automationNotificationTarget$ = computed((get) => {
  return automationNotificationDestination(
    get(pathname$),
    get(searchParams$).toString(),
  );
});

export const workflowAutomationNotificationAccess$ = computed(async (get) => {
  get(workflowReloadVersion$);
  get(pageVersion$);
  const target = get(automationNotificationTarget$);
  if (!target) {
    return { status: "unavailable" } as const;
  }
  const org = await get(currentOrgInfo$);
  if (org?.id !== target.workspaceId) {
    const clerk = await get(clerk$);
    const user = clerk.user;
    if (!user) {
      return { status: "unavailable" } as const;
    }
    // Recheck live membership rather than treating the notification snapshot as
    // an access grant. Membership pagination is finite, not timed polling.
    let page = 1;
    let seen = 0;
    while (true) {
      const memberships = await user.getOrganizationMemberships({
        initialPage: page,
        pageSize: 100,
      });
      const membership = memberships.data.find((item) => {
        return item.organization.id === target.workspaceId;
      });
      if (membership) {
        return {
          status: "switchWorkspace",
          workspaceName: membership.organization.name,
        } as const;
      }
      seen += memberships.data.length;
      if (memberships.data.length === 0 || seen >= memberships.total_count) {
        return { status: "unavailable" } as const;
      }
      page += 1;
    }
  }
  // The personal notification is a historical snapshot, not proof the target
  // still exists or belongs to this user/workspace.
  const response = await accept(
    get(apiClient$)(workflowAutomationsContract).get({
      params: { id: target.automationId },
    }),
    [200, 403, 404],
    undefined,
    { showErrorToast: false },
  );
  if (response.status !== 200) {
    return { status: "unavailable" } as const;
  }
  const detail = await get(currentWorkflowDetail$);
  if (
    !detail ||
    !detail.automations.some((automation) => {
      return automation.id === target.automationId;
    })
  ) {
    return { status: "unavailable" } as const;
  }
  return { status: "ready" } as const;
});

export const switchAutomationNotificationWorkspace$ = command(
  async ({ get }, signal: AbortSignal) => {
    const access = await get(workflowAutomationNotificationAccess$);
    signal.throwIfAborted();
    const target = get(automationNotificationTarget$);
    if (access.status !== "switchWorkspace" || !target) {
      return;
    }
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    // The normal org-switch watcher reloads the controlled URL in the new
    // workspace. It does not carry arbitrary return URLs or business actions.
    await clerk.setActive({ organization: target.workspaceId });
    signal.throwIfAborted();
  },
);
