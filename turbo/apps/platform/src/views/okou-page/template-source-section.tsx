import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@okouai/ui";

export function TemplateSourceSection({
  source,
  count,
  children,
}: {
  readonly source: "custom" | "builtIn";
  readonly count?: number;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const title =
    source === "custom"
      ? t(($) => {
          return $.templates.custom;
        })
      : t(($) => {
          return $.templates.builtIn;
        });
  return (
    <section
      aria-label={title}
      className={cn(
        "shrink-0",
        source === "builtIn" && "mt-7 border-t border-t-gray-400 pt-5",
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {count === undefined ? null : (
          <span className="rounded bg-gray-50 px-1.5 text-xs text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}
