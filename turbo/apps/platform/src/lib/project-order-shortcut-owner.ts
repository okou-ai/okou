/** The nearest list/menu owner wins, including a chat inside a Project. */
export function projectOrderShortcutOwner(target: EventTarget | null) {
  const owner =
    target instanceof Element
      ? target.closest<HTMLElement>(
          "[data-project-menu-content-id], [data-project-row-id], [data-chat-thread-menu-thread-id], [data-sidebar-chat-thread-row-id], [data-chat-thread-container-id]",
        )
      : null;
  if (!owner) {
    return null;
  }
  const projectId =
    owner.dataset.projectMenuContentId ?? owner.dataset.projectRowId;
  return projectId
    ? { kind: "project" as const, projectId }
    : { kind: "chat" as const };
}
