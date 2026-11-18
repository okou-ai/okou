const UUID_PATH_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface AutomationEventDestination {
  readonly workflowId: string;
  readonly automationId: string;
  readonly workspaceId: string;
}

/** A event can continue only to this exact, controlled management route. */
export function automationEventDestination(
  pathname: string,
  search: string,
): AutomationEventDestination | null {
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

export function automationEventLocation(
  destination: AutomationEventDestination,
): string {
  const params = new URLSearchParams({
    automationId: destination.automationId,
    workspaceId: destination.workspaceId,
  });
  return `/workflows/${encodeURIComponent(destination.workflowId)}/automations?${params}`;
}
