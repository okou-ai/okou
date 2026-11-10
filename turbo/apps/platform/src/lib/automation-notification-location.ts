const UUID_PATH_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface AutomationNotificationDestination {
  readonly workflowId: string;
  readonly automationId: string;
  readonly workspaceId: string;
}

/** A notification can continue only to this exact, controlled management route. */
export function automationNotificationDestination(
  pathname: string,
  search: string,
): AutomationNotificationDestination | null {
  const match = /^\/workflows\/([^/]+)\/automations$/u.exec(pathname);
  const params = new URLSearchParams(search);
  const workflowId = match?.[1];
  const automationId = params.get("automationId");
  const workspaceId = params.get("workspaceId");
  if (
    !workflowId ||
    !UUID_PATH_SEGMENT.test(workflowId) ||
    !automationId ||
    !UUID_PATH_SEGMENT.test(automationId) ||
    !workspaceId
  ) {
    return null;
  }
  return { workflowId, automationId, workspaceId };
}

export function automationNotificationLocation(
  destination: AutomationNotificationDestination,
): string {
  const params = new URLSearchParams({
    automationId: destination.automationId,
    workspaceId: destination.workspaceId,
  });
  return `/workflows/${encodeURIComponent(destination.workflowId)}/automations?${params}`;
}
