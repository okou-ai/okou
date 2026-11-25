/** The nearest list/menu owner wins, including a chat inside a Project. */
export function listShortcutOwner(target: EventTarget | null) {
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

/** Rename and archive act on the open menu, the focused row, or the current page. */
export function projectActionShortcutId(
  target: EventTarget | null,
  selectedProjectId: string | null = null,
): string | null {
  const menu = document.querySelector<HTMLElement>('[role="menu"][data-open]');
  if (menu) {
    return menu.dataset.projectMenuContentId ?? null;
  }
  const owner = listShortcutOwner(target);
  return owner?.kind === "chat"
    ? null
    : (owner?.projectId ?? selectedProjectId);
}
