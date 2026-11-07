import { SwatchBook } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";

export function ComposerTemplatePickerButton({
  onClick,
}: {
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="quiet"
      size="icon-sm"
      iconSize="md"
      showTooltip
      aria-label={t(($) => {
        return $.chat.taskChips.viewAll;
      })}
      className="shrink-0 text-muted-foreground"
      onClick={onClick}
    >
      <SwatchBook aria-hidden />
    </Button>
  );
}
