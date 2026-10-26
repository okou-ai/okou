import { processShortcut, type KeyboardEventLike } from "@okouai/ui";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ensurePushSubscription$ } from "../../lib/push-notifications.ts";
import { isMobileTextInputDevice } from "../../lib/visual-viewport-keyboard.ts";
import type {
  ComposerPrimaryAction,
  ComposerSignals,
} from "../../signals/okou-page/composer-signals.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { sendMode$ } from "../../signals/send-mode.ts";
import { detach, Reason } from "../../signals/utils.ts";

export type ComposerActions = ReturnType<typeof useComposerActions>;

/** One submission invocation owner shared by the editor and send control. */
export function useComposerActions(signals: ComposerSignals) {
  const bindVoiceShortcut = useSet(signals.voice.setRootRef$);
  const [submissionLoadable, submit] = useLoadableSet(
    signals.submission.activatePrimaryAction$,
  );
  const hasCurrentSubmission = useGet(signals.submission.hasCurrentInvocation$);
  return {
    bind: bindVoiceShortcut,
    submit,
    submitting: hasCurrentSubmission && submissionLoadable.state === "loading",
  };
}

export function useComposerPrimaryAction(
  signals: ComposerSignals,
  actions: ComposerActions,
): ComposerPrimaryAction {
  const voiceDraft = useLoadable(signals.voice.state$);
  // Keep the last action while the thread's events resync; falling back to
  // "disabled" on every recompute would unmount and remount Stop mid-run.
  const action =
    useLastResolved(signals.submission.primaryAction$) ?? "disabled";
  const uploads = useLoadable(signals.draft.attachmentUploadsReady$);
  const sending = useLastResolved(signals.submission.sending$) ?? false;
  const availableAction =
    uploads.state === "hasData" && uploads.data
      ? action
      : sending
        ? "stop"
        : "disabled";
  const selectedModelOauthAvailable =
    useLastResolved(signals.model.selectedModelOauthAvailable$) ?? true;
  return selectedModelOauthAvailable &&
    (!actions.submitting || availableAction === "stop") &&
    voiceDraft.state === "hasData" &&
    voiceDraft.data.status === "idle"
    ? availableAction
    : "disabled";
}

export function startComposerSubmission(
  {
    action,
    activate,
    ensurePushSubscription,
  }: {
    action: ComposerPrimaryAction;
    activate: (signal: AbortSignal) => Promise<boolean>;
    ensurePushSubscription: (signal: AbortSignal) => Promise<void>;
  },
  signal: AbortSignal,
): void {
  if (action === "disabled" || action === "stop") {
    return;
  }
  if (action === "send") {
    detach(ensurePushSubscription(signal), Reason.DomCallback);
  }
  detach(activate(signal), Reason.DomCallback);
}

/** Own keyboard availability beside the controls, not the editor subtree. */
export function useComposerKeyboard(
  signals: ComposerSignals,
  actions: ComposerActions,
) {
  const primaryAction = useComposerPrimaryAction(signals, actions);
  const ensurePushSubscription = useSet(ensurePushSubscription$);
  const rootSignal = useGet(rootSignal$);
  const sendModeLoadable = useLastLoadable(sendMode$);
  const sendMode =
    sendModeLoadable.state === "hasData" ? sendModeLoadable.data : "enter";
  const submit = () => {
    startComposerSubmission(
      {
        action: primaryAction,
        activate: (signal) => {
          return actions.submit(primaryAction, signal);
        },
        ensurePushSubscription,
      },
      rootSignal,
    );
  };
  return (event: KeyboardEventLike) => {
    const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;
    if (isMobileTextInputDevice()) {
      processShortcut({ "mod+enter": submit }, event);
      return;
    }
    processShortcut(
      {
        ...(sendMode === "enter" ? { enter: submit } : { "mod+enter": submit }),
        ...(isTouchDevice && sendMode === "enter"
          ? { "mod+enter": submit }
          : {}),
        escape: () => {
          (event.target as HTMLElement).blur();
        },
      },
      event,
    );
  };
}
