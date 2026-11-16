import type { ReactNode } from "react";
import { Eye } from "lucide-react";
import { IconButton } from "@okouai/ui";
import { useTranslation } from "react-i18next";

/** Keep preview and selection as sibling buttons, with separate hit targets. */
export function ComposerTemplateSuggestion({
  title,
  onPreview,
  children,
}: {
  readonly title: string;
  readonly onPreview?: () => void;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="group/tile group/suggestion relative min-w-0">
      {children}
      {onPreview ? (
        <IconButton
          aria-label={t(
            ($) => {
              return $.chat.templates.previewTemplate;
            },
            { title },
          )}
          aria-haspopup="dialog"
          showTooltip
          className="absolute top-2 right-2 z-20 bg-[rgb(0_0_0/0.45)] text-[#ffffff] hover:bg-[rgb(0_0_0/0.6)] [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/suggestion:opacity-100 [@media(hover:hover)]:group-focus-within/suggestion:opacity-100"
          onClick={onPreview}
        >
          <Eye size={18} aria-hidden />
        </IconButton>
      ) : null}
    </div>
  );
}
