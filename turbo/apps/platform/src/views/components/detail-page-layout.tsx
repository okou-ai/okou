import type { CSSProperties, ReactNode } from "react";
import { cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";

const DETAIL_PAGE_CONTENT_CLASS = "mx-auto w-full max-w-[900px]";

export function DetailPageShell({
  children,
  className,
  scroll = true,
  style,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly scroll?: boolean;
  readonly style?: CSSProperties;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        scroll ? "overflow-auto [scrollbar-gutter:stable]" : "",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}

export function DetailPageBreadcrumbBar({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t(($) => {
        return $.shared.breadcrumb;
      })}
      className={cn(
        "hidden shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground md:flex",
        className,
      )}
    >
      {children}
    </nav>
  );
}

export function DetailPageHeader({
  children,
  className,
  contentClassName,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
}) {
  return (
    <header
      className={cn(
        "shrink-0 bg-transparent px-4 pt-6 pb-0 sm:px-6",
        className,
      )}
    >
      <div className={cn(DETAIL_PAGE_CONTENT_CLASS, contentClassName)}>
        {children}
      </div>
    </header>
  );
}

export function DetailPageMain({
  children,
  className,
  contentClassName,
  constrainContent = false,
  scrollable = false,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly constrainContent?: boolean;
  readonly scrollable?: boolean;
}) {
  return (
    <main
      className={cn(
        scrollable ? "min-h-0 flex-1 overflow-auto" : "shrink-0",
        "px-4 pt-4 pb-safe-or-16 sm:px-6 sm:pt-6",
        className,
      )}
    >
      {constrainContent ? (
        <div className={cn(DETAIL_PAGE_CONTENT_CLASS, contentClassName)}>
          {children}
        </div>
      ) : (
        children
      )}
    </main>
  );
}
