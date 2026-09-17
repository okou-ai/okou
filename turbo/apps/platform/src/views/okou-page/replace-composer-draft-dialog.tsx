import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { useGet, useSet } from "ccstate-react";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";

export function ReplaceComposerDraftDialog({
  signals,
}: {
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const open = useGet(signals.workflow.replaceWorkflowPromptOpen$);
  const setOpen = useSet(signals.workflow.setReplaceWorkflowPromptOpen$);
  const confirm = useSet(signals.workflow.confirmReplaceWorkflowPrompt$);
  const pageSignal = useGet(pageSignal$);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent smMaxWidth="sm">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.chat.replaceDraft.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.chat.replaceDraft.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setOpen(false);
            }}
          >
            {t(($) => {
              return $.chat.actions.cancel;
            })}
          </Button>
          <Button
            type="button"
            onClick={() => {
              detach(confirm(pageSignal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.chat.actions.continue;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
