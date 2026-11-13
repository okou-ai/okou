import type { ReactNode, Ref } from "react";
import { cn } from "@okouai/ui";
import { isStandalonePwa } from "../../lib/keyboard-dismiss-gesture.ts";

/** Shared geometry for discovery pages and conversation panes. */
export function ChatPageLayout({
  header,
  children,
  footer,
}: {
  readonly header: ReactNode;
  readonly children: ReactNode;
  readonly footer: ReactNode;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {header}
      <div className="isolate relative flex min-h-0 flex-1 flex-col">
        {children}
        {footer}
      </div>
    </div>
  );
}

export function ChatPageHeader({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center justify-between bg-transparent px-6",
        className,
      )}
    >
      {children}
    </header>
  );
}

export function ChatComposerFooter({
  children,
  ref,
}: {
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLElement>;
}) {
  return (
    <footer data-chat-composer ref={ref} className="relative shrink-0">
      <div
        className={cn(
          "overflow-y-auto [scrollbar-gutter:stable] px-4 pb-safe-or-4 pt-3 sm:px-6",
          isStandalonePwa() && "overscroll-contain",
        )}
      >
        <div className="mx-auto max-w-[900px]">{children}</div>
      </div>
    </footer>
  );
}
