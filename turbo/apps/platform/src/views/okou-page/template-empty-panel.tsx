import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Shown when a search matches nothing. Lives in its own module because the
 * template picker's category grids and the Custom panel both render it, and a
 * second copy would be a second thing to keep worded the same.
 */
export function TemplateEmptyPanel() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-40 flex-1 items-center justify-center rounded-[22px] border-2 border-dashed border-border bg-background px-6 py-10 text-center">
      <div className="flex max-w-xl flex-col items-center">
        <Search className="mb-4 h-8 w-8" />
        <p className="text-sm font-semibold text-muted-foreground">
          {t(($) => {
            return $.artifacts.templates.noMatches;
          })}
        </p>
        <p className="mt-2 text-sm text-muted-foreground/80">
          {t(($) => {
            return $.artifacts.templates.tryDifferentSearch;
          })}
        </p>
      </div>
    </div>
  );
}
