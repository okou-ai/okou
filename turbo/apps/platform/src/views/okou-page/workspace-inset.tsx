import type { ReactNode } from "react";

export function WorkspaceInset({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="relative z-0 before:absolute before:inset-0 before:-z-1 before:bg-workspace-canvas before:bg-workspace-canvas-image before:bg-[length:100%_100%] before:content-[''] flex min-h-0 min-w-0 flex-1 flex-col bg-background md:m-2 md:ml-0 md:overflow-hidden md:rounded-xl md:border md:border-border"
      data-testid="workspace-inset"
    >
      {children}
    </div>
  );
}
