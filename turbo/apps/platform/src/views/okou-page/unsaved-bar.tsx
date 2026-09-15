import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Pencil, Loader2 } from "lucide-react";
import { surfaceVariants, Button, cn } from "@okouai/ui";

/**
 * Where the bar is pinned, and therefore which element it portals into. A form
 * inside the settings dialog anchors to that dialog so the bar scrolls and
 * stacks with it; everything else anchors to the app shell.
 */
type UnsavedBarAnchor = "page" | "settings-dialog";

interface AnchorConfig {
  readonly containerId: string;
  readonly className: string;
  /**
   * Whether a missing container still renders the bar where it was written.
   * The app shell root always exists in the product, so falling back keeps the
   * bar visible when a test mounts a subtree on its own. A missing settings
   * dialog instead means that dialog is closed, and the bar must not escape
   * into the page behind it.
   */
  readonly renderInPlaceWithoutContainer: boolean;
}

const ANCHORS: Record<UnsavedBarAnchor, AnchorConfig> = {
  page: {
    containerId: "root",
    // The shell root is outside the `.okou-app` subtree, so the bar re-enters
    // that scope to read its tokens. Modal and floating Base UI portals live
    // outside it and stay above the bar without coordinating z-index values.
    className: "okou-app fixed bottom-[max(1.5rem,var(--sab))] z-40",
    renderInPlaceWithoutContainer: true,
  },
  "settings-dialog": {
    containerId: "settings-dialog-content",
    className: "absolute bottom-6 z-10",
    renderInPlaceWithoutContainer: false,
  },
};

interface UnsavedBarProps {
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
  anchor?: UnsavedBarAnchor;
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
  anchor = "page",
  saveDisabled = false,
  testId = "unsaved-bar",
  message,
  discardLabel,
  saveLabel,
}: UnsavedBarProps) {
  const { t } = useTranslation();
  const config = ANCHORS[anchor];

  const bar = (
    <div
      className={cn(
        "left-0 right-0 flex justify-center px-4",
        config.className,
      )}
    >
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

  const container =
    typeof document === "undefined"
      ? null
      : document.getElementById(config.containerId);
  if (container) {
    return createPortal(bar, container);
  }
  return config.renderInPlaceWithoutContainer ? bar : null;
}
