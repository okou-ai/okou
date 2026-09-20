import { useTranslation } from "react-i18next";
import { Pencil, Loader2 } from "lucide-react";
import { surfaceVariants, Button, cn } from "@okouai/ui";

/**
 * Pins the bar to the viewport above the page it belongs to. Base UI's floating
 * layers portal outside the app shell, so they stay above the bar without
 * coordinating z-index values.
 */
const PAGE_PINNING =
  "fixed left-0 right-0 bottom-[max(1.5rem,var(--sab))] z-40";

interface UnsavedBarProps {
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
  /**
   * Replaces the viewport pinning. A bar written inside a scrollport passes
   * `sticky` so it rides that scrollport instead of the viewport.
   */
  pinning?: string;
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
  pinning = PAGE_PINNING,
  saveDisabled = false,
  testId = "unsaved-bar",
  message,
  discardLabel,
  saveLabel,
}: UnsavedBarProps) {
  const { t } = useTranslation();

  return (
    <div className={cn("flex justify-center px-4", pinning)}>
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
