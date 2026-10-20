import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@okouai/ui";

/**
 * One source of templates in a picker tab: the member's own, or the built-ins.
 *
 * The two used to carry a heading each, a count and a rule between them. The
 * member's own cards already say so on their own line (their visibility), and
 * the import tile leads the wall, so the sections now stack as one wall: the
 * gap between them is the grids' own row gap, and the source is named for
 * assistive technology only.
 */
export function TemplateSourceSection({
  source,
  children,
}: {
  readonly source: "custom" | "builtIn";
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
      className={cn("shrink-0", source === "builtIn" && "mt-5")}
    >
      {children}
    </section>
  );
}
