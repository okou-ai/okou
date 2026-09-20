import type { ReactNode } from "react";

/**
 * The workspace sheet: the app's canvas, framed by the chrome around it. The
 * chat list supplies the left edge in the app shell, so the sheet drops that
 * margin there; beside the bare nav rail -- or with no chrome at all -- nothing
 * supplies it, so the sheet keeps the frame on all four sides.
 */
export function WorkspaceInset({
  beside = "chat-list",
  children,
}: {
  readonly beside?: "chat-list" | "nav-rail" | "nothing";
  readonly children: ReactNode;
}) {
  return (
    <div
      className={`relative z-0 before:absolute before:inset-0 before:-z-1 before:bg-workspace-canvas before:bg-workspace-canvas-image before:bg-[length:100%_100%] before:content-[''] flex min-h-0 min-w-0 flex-1 flex-col bg-background md:m-2 md:overflow-hidden md:rounded-xl md:border md:border-border ${
        beside === "chat-list" ? "md:ml-0" : ""
      }`}
      data-testid="workspace-inset"
    >
      {children}
    </div>
  );
}
