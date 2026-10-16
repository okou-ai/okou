// The chat actions the slash menu offers when the slash-actions switch is on.
// Each one consumes the slash token, closes the menu, and then hands over to
// the control that already owns the action elsewhere in the product.
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import {
  Archive,
  Box,
  CalendarClock,
  Gauge,
  PencilLine,
  Pin,
  PinOff,
  Plug,
  Share2,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { CREATE_AUTOMATION_CHAT_PROMPT } from "../../signals/chat-page/workflow-prompt-action.ts";
import {
  pinChatThread$,
  unpinChatThread$,
} from "../../signals/chat-page/chat-event.ts";
import { chatThreadMetaMap$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { setChatThreadArchivedWithFeedback$ } from "../../signals/chat-page/chat-thread-archive.ts";
import { openRenameChatThreadDialogForThreadId$ } from "../../signals/chat-page/chat-thread-rename.ts";
import { startComposerThreadSharing$ } from "../../signals/okou-page/slash-actions.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { availableRunModels$ } from "../../signals/external/run-models.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";

export interface SlashAction {
  readonly id: string;
  readonly Icon: LucideIcon;
  readonly label: string;
  /** What the action does, read after its name in a quieter ink. */
  readonly hint?: string;
  readonly run: () => void;
}

/** Whether the overview leads with actions instead of the workflow rows. */
export function useSlashActionsEnabled(): boolean {
  return useGet(featureSwitch$)[FeatureSwitchKey.SlashActions] === true;
}

/**
 * Whether the composer shows its model picker: the same rule its toolbar
 * slot follows, so Model and Effort never point at a control that is absent.
 */
function useModelPickerShown(composer: ComposerSignals): boolean {
  const models = useLastResolved(availableRunModels$);
  const selection = useLastLoadable(composer.model.modelSelection$);
  return (
    models !== undefined &&
    models.models.some((runModel) => {
      return runModel.model !== null;
    }) &&
    selection.state === "hasData" &&
    selection.data !== null
  );
}

/** The actions that change how this chat runs. */
function useComposerActions(
  composer: ComposerSignals,
  leave: () => void,
): SlashAction[] {
  const { t } = useTranslation();
  const openModelPicker = useSet(composer.model.setModelPickerOpen$);
  const openConnectors = useSet(composer.connector.openAddConnectorsDialog$);
  const insertText = useSet(composer.editor.insertText$);
  const modelActions: SlashAction[] = [
    {
      id: "model",
      Icon: Box,
      label: t(($) => {
        return $.chat.composer.slashActions.model;
      }),
      hint: t(($) => {
        return $.chat.composer.slashActions.modelHint;
      }),
      run: () => {
        leave();
        openModelPicker(true);
      },
    },
    {
      // Effort lives in the model picker, so it opens the same panel.
      id: "effort",
      Icon: Gauge,
      label: t(($) => {
        return $.chat.composer.slashActions.effort;
      }),
      hint: t(($) => {
        return $.chat.composer.slashActions.effortHint;
      }),
      run: () => {
        leave();
        openModelPicker(true);
      },
    },
  ];
  return [
    ...(useModelPickerShown(composer) ? modelActions : []),
    {
      id: "connect",
      Icon: Plug,
      label: t(($) => {
        return $.chat.composer.slashActions.connect;
      }),
      hint: t(($) => {
        return $.chat.composer.slashActions.connectHint;
      }),
      run: () => {
        leave();
        openConnectors();
      },
    },
    {
      // The same request the Workflows page's automation flow starts a chat
      // with, written where the token was so it can be edited before sending.
      id: "schedule",
      Icon: CalendarClock,
      label: t(($) => {
        return $.chat.composer.slashActions.schedule;
      }),
      hint: t(($) => {
        return $.chat.composer.slashActions.scheduleHint;
      }),
      run: () => {
        leave();
        insertText(CREATE_AUTOMATION_CHAT_PROMPT);
      },
    },
  ];
}

/** The actions on the chat itself; a new chat has none of them yet. */
function useThreadActions(
  composer: ComposerSignals,
  leave: () => void,
): SlashAction[] {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const openRename = useSet(openRenameChatThreadDialogForThreadId$);
  const pin = useSet(pinChatThread$);
  const unpin = useSet(unpinChatThread$);
  const setArchived = useSet(setChatThreadArchivedWithFeedback$);
  const startSharing = useSet(startComposerThreadSharing$);
  const meta = useGet(chatThreadMetaMap$);
  const archiving =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatThreadArchiving] === true;
  const threadId = composer.threadId;
  if (threadId === undefined) {
    return [];
  }
  const pinned = Boolean(meta.get(threadId)?.pinnedAt);
  const actions: SlashAction[] = [
    {
      id: "new-chat",
      Icon: SquarePen,
      label: t(($) => {
        return $.chat.composer.slashActions.newChat;
      }),
      hint: t(($) => {
        return $.chat.composer.slashActions.newChatHint;
      }),
      run: () => {
        leave();
        navigate(ROUTES.agentChat, {
          pathParams: { agentId: composer.agentId },
        });
      },
    },
    {
      id: "rename",
      Icon: PencilLine,
      label: t(($) => {
        return $.chat.composer.slashActions.rename;
      }),
      run: () => {
        leave();
        openRename(threadId, pageSignal);
      },
    },
    {
      id: "pin",
      Icon: pinned ? PinOff : Pin,
      label: pinned
        ? t(($) => {
            return $.chat.composer.slashActions.unpin;
          })
        : t(($) => {
            return $.chat.composer.slashActions.pin;
          }),
      run: () => {
        leave();
        detach(
          (pinned ? unpin : pin)(threadId, pageSignal),
          Reason.DomCallback,
        );
      },
    },
  ];
  if (archiving) {
    actions.push({
      id: "archive",
      Icon: Archive,
      label: t(($) => {
        return $.chat.composer.slashActions.archive;
      }),
      run: () => {
        leave();
        detach(
          setArchived({ threadId, archived: true }, pageSignal),
          Reason.DomCallback,
        );
      },
    });
  }
  actions.push({
    id: "share",
    Icon: Share2,
    label: t(($) => {
      return $.chat.composer.slashActions.share;
    }),
    hint: t(($) => {
      return $.chat.composer.slashActions.shareHint;
    }),
    run: () => {
      leave();
      detach(startSharing(threadId, pageSignal), Reason.DomCallback);
    },
  });
  return actions;
}

/**
 * Everything the overview lists before Workflows and Templates. `leave`
 * consumes the token and closes the menu before the action takes over.
 */
export function useSlashActions(
  composer: ComposerSignals,
  leave: () => void,
): readonly SlashAction[] {
  return [
    ...useComposerActions(composer, leave),
    ...useThreadActions(composer, leave),
  ];
}
