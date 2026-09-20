import { useTranslation } from "react-i18next";
import { Pencil, Loader2 } from "lucide-react";
import { surfaceVariants, Button, cn } from "@okouai/ui";

/**
 * What the bar is pinned against. `viewport` sits above the page it belongs to;
 * Base UI's floating layers portal outside the app shell, so they stay above it
 * without coordinating z-index values. `scrollport` rides the scrolling section
 * the bar is written inside, which is what a bar inside a dialog needs.
 */
type UnsavedBarPinning = "viewport" | "scrollport";

const PINNINGS: Readonly<Record<UnsavedBarPinning, string>> = {
  viewport: "fixed left-0 right-0 bottom-[max(1.5rem,var(--sab))] z-40",
  scrollport: "sticky bottom-6 z-10",
};

interface UnsavedBarProps {
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
  pinning?: UnsavedBarPinning;
  /** Blocks saving while the form cannot produce a valid value. */
  saveDisabled?: boolean;
  testId?: string;
  message?: string;
  discardLabel?: string;
  saveLabel?: string;
}

export function UnsavedBar({
  onDiscard,
  onSave,
  saving,
  pinning = "viewport",
  saveDisabled = false,
  testId = "unsaved-bar",
  message,
  discardLabel,
  saveLabel,
}: UnsavedBarProps) {
  const { t } = useTranslation();

  return (
    <div className={cn("flex justify-center px-4", PINNINGS[pinning])}>
      <div
        data-testid={testId}
        className={surfaceVariants({
          className:
            "flex max-w-md items-center justify-between gap-4 px-5 py-4",
        })}
      >
        <div className="flex items-center gap-2 text-sm text-foreground">
          <Pencil size={18} className="shrink-0" />
          <span>
            {message ??
              t(($) => {
                return $.settings.workspace.unsaved.message;
              })}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            data-testid="discard-button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDiscard}
            disabled={saving}
          >
            {discardLabel ??
              t(($) => {
                return $.settings.shared.discard;
              })}
          </Button>
          <Button
            data-testid="save-button"
            size="sm"
            className="h-9 rounded-lg px-4 bg-primary text-primary-foreground hover:bg-primary-hover"
            onClick={onSave}
            disabled={saving || saveDisabled}
          >
            {saving ? (
              <Loader2
                data-testid="save-spinner"
                size={14}
                className="animate-spin mr-1.5"
              />
            ) : null}
            {saveLabel ??
              t(($) => {
                return $.settings.shared.save;
              })}
          </Button>
        </div>
      </div>
    </div>
  );
}
