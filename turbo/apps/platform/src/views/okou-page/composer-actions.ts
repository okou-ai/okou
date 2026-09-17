import { useGet, useLoadableState, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";

export type ComposerActions = ReturnType<typeof useComposerActions>;

/** One invocation owner for the editor, footer, and global voice shortcut. */
export function useComposerActions(signals: ComposerSignals) {
  const voiceState = useLoadableState(signals.voice.result$);
  const voice = useSet(signals.voice.run$);
  const voiceAction = useGet(signals.voice.action$);
  const bind = useSet(signals.voice.setRootRef$);
  const [submissionLoadable, submit] = useLoadableSet(
    signals.submission.activatePrimaryAction$,
  );
  const hasCurrentSubmission = useGet(signals.submission.hasCurrentInvocation$);
  return {
    bind,
    voice,
    voiceAction: voiceState === "loading" ? voiceAction : null,
    submit,
    submitting: hasCurrentSubmission && submissionLoadable.state === "loading",
  };
}
