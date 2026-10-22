import type { ReactNode } from "react";
import { Button } from "@okouai/ui";
import { REMOTE_PAGE_ACTION } from "./remote-editor-frame.tsx";

export function RemoteFormFooter({
  separated,
  destructive,
  onCancel,
  cancelLabel,
  cancelDisabled,
  submitLabel,
  submitDisabled,
}: {
  readonly separated: boolean;
  readonly destructive: boolean;
  readonly onCancel?: () => void;
  readonly cancelLabel: ReactNode;
  readonly cancelDisabled: boolean;
  readonly submitLabel: ReactNode;
  readonly submitDisabled: boolean;
}) {
  return (
    <div
      className={
        separated
          ? "mt-2 flex shrink-0 flex-wrap justify-end gap-3 border-t border-divider pt-5"
          : "flex shrink-0 justify-end gap-2"
      }
    >
      {onCancel && (
        <Button
          type="button"
          variant="outline"
          disabled={cancelDisabled}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
      )}
      <Button
        type="submit"
        className={separated && !destructive ? REMOTE_PAGE_ACTION : undefined}
        variant={destructive ? "destructive" : "default"}
        disabled={submitDisabled}
      >
        {submitLabel}
      </Button>
    </div>
  );
}
