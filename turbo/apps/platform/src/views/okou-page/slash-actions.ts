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
  BriefcaseBusiness,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Gauge,
  PencilLine,
  Pin,
  PinOff,
  Plug,
  Share2,
  SquarePen,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { isMemberRunModelConfigurable } from "@okouai/api-contracts/contracts/member-run-model";
import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { withModelReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  CREATE_AUTOMATION_CHAT_PROMPT,
  scheduledAutomationChatPrompt,
} from "../../signals/chat-page/workflow-prompt-action.ts";
import {
  pinChatThread$,
  unpinChatThread$,
} from "../../signals/chat-page/chat-event.ts";
import { chatThreadMetaMap$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { setChatThreadArchivedWithFeedback$ } from "../../signals/chat-page/chat-thread-archive.ts";
import { openRenameChatThreadDialogForThreadId$ } from "../../signals/chat-page/chat-thread-rename.ts";
import { startComposerThreadSharing$ } from "../../signals/okou-page/slash-actions.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { modelCatalog$ } from "../../signals/external/model-catalog.ts";
import { availableRunModels$ } from "../../signals/external/run-models.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  formatChatEffort,
  useChatEffort,
} from "./components/chat-effort-controls.tsx";
import {
  resolveModelFirstModelPickerState,
  selectedModelControlValue,
  selectedModelDisplayName,
  useExplicitModelSelectionChange,
  type ModelProviderSelection,
} from "./components/model-provider-picker.tsx";

export interface SlashAction {
  readonly id: string;
  readonly Icon: LucideIcon;
  readonly label: string;
  /** What the action does, read after its name in a quieter ink. */
  readonly hint?: string;
  /**
   * The command words a typed slash also finds it by. They stay English,
   * like the commands of other chat apps, while the label is translated.
   */
  readonly keywords: readonly string[];
  /** Choices the overview lists as this action's second level. */
  readonly submenu?: SlashSubmenu;
  /** What choosing it does where there is no second level, as in a search. */
  readonly run: () => void;
}

/** One row of an action's second level. */
export interface SlashSubmenuItem {
  readonly id: string;
  /** The row's name, and its accessible name. */
  readonly label: string;
  readonly Icon?: LucideIcon;
  /** A model row draws the model picker's own row content. */
  readonly runModel?: AvailableRunModel;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly run: () => void;
}

export interface SlashSubmenu {
  readonly items: readonly SlashSubmenuItem[];
  /** A quieter last row under a divider, such as Custom schedule. */
  readonly footer?: SlashSubmenuItem;
}

/**
 * Whether a typed slash query names the action: the label or one of its
 * keywords starts with it, or one of their words does, so `/re` finds Rename
 * chat but not Share chat. Keywords are the action's own command words, not
 * loose synonyms, so a short query does not surface unrelated actions.
 */
export function slashActionMatches(action: SlashAction, query: string) {
  const normalized = query.toLowerCase().trim();
  if (normalized === "") {
    return false;
  }
  return [action.label, ...action.keywords].some((name) => {
    const lower = name.toLowerCase();
    return (
      lower.startsWith(normalized) ||
      lower.split(/\s+/u).some((word) => {
        return word.startsWith(normalized);
      })
    );
  });
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

function useModelSelectionChange(
  composer: ComposerSignals,
): (selection: ModelProviderSelection | null) => void {
  const setModelSelection = useSet(composer.model.setModelSelection$);
  const pageSignal = useGet(pageSignal$);
  return (selection) => {
    detach(setModelSelection(selection, pageSignal), Reason.DomCallback);
  };
}

/**
 * The model picker's choices as second levels: its models, then the checked
 * model's effort levels. Choosing one applies it the way the picker does.
 */
function useModelSubmenus(
  composer: ComposerSignals,
  selection: ModelProviderSelection | null,
  leave: () => void,
): { readonly model: SlashSubmenu; readonly effort: SlashSubmenu } {
  const models = useLastResolved(availableRunModels$);
  const catalog = useLastResolved(modelCatalog$);
  const onChange = useModelSelectionChange(composer);
  const changeModel = useExplicitModelSelectionChange({
    value: selection,
    onChange,
  });
  const { efforts, effort: currentEffort } = useChatEffort(selection);
  if (selection === null) {
    return { model: { items: [] }, effort: { items: [] } };
  }
  const state = resolveModelFirstModelPickerState({
    value: selection,
    modelsResponse: models,
    catalog,
  });
  const selectedRunModel = state.models.find((runModel) => {
    return runModel.model === selection.selectedModel;
  });
  const configurable =
    selectedRunModel !== undefined &&
    isMemberRunModelConfigurable(selectedRunModel);
  return {
    model: {
      items: state.models.map((runModel) => {
        return {
          id: selectedModelControlValue(runModel.model),
          label: selectedModelDisplayName(catalog, runModel.model),
          runModel,
          checked: state.selection?.selectedModel === runModel.model,
          disabled: !isMemberRunModelConfigurable(runModel),
          run: () => {
            leave();
            changeModel(
              selection.selectedModel === runModel.model
                ? selection
                : { selectedModel: runModel.model },
            );
          },
        };
      }),
    },
    effort: {
      items: efforts.map((level) => {
        return {
          id: level,
          label: formatChatEffort(level),
          checked: level === currentEffort,
          disabled: !configurable,
          run: () => {
            leave();
            const model = selection.selectedModel;
            if (model !== null) {
              onChange({
                ...selection,
                modelSettings: withModelReasoningEffort(
                  selection.modelSettings,
                  { model, effort: level },
                ),
              });
            }
          },
        };
      }),
    },
  };
}

/**
 * Model, and Effort when the model has levels; both need the picker. Their
 * second levels list the choices; a typed search runs them straight into the
 * picker instead.
 */
function useModelActions(
  composer: ComposerSignals,
  leave: () => void,
): SlashAction[] {
  const { t } = useTranslation();
  const openModelPicker = useSet(composer.model.setModelPickerOpen$);
  const pickerShown = useModelPickerShown(composer);
  const selection = useLastResolved(composer.model.modelSelection$) ?? null;
  const submenus = useModelSubmenus(composer, selection, leave);
  if (!pickerShown) {
    return [];
  }
  const openPicker = () => {
    leave();
    openModelPicker(true);
  };
  const model: SlashAction = {
    id: "model",
    Icon: Box,
    label: t(($) => {
      return $.chat.composer.slashActions.model;
    }),
    hint: t(($) => {
      return $.chat.composer.slashActions.modelHint;
    }),
    keywords: ["model"],
    submenu: submenus.model,
    run: openPicker,
  };
  const effort: SlashAction = {
    id: "effort",
    Icon: Gauge,
    label: t(($) => {
      return $.chat.composer.slashActions.effort;
    }),
    hint: t(($) => {
      return $.chat.composer.slashActions.effortHint;
    }),
    keywords: ["effort", "reasoning", "think"],
    submenu: submenus.effort,
    run: openPicker,
  };
  return submenus.effort.items.length > 0 ? [model, effort] : [model];
}

/**
 * How often a new automation runs. Choosing one writes the automation request
 * with that cadence; Custom schedule writes it without one.
 */
function useScheduleSubmenu(
  composer: ComposerSignals,
  leave: () => void,
): SlashSubmenu {
  const { t } = useTranslation();
  const insertText = useSet(composer.editor.insertText$);
  const write = (prompt: string) => {
    return () => {
      leave();
      insertText(prompt);
    };
  };
  const presets = [
    {
      id: "every-morning",
      Icon: Sun,
      label: t(($) => {
        return $.chat.composer.slashActions.scheduleEveryMorning;
      }),
      cadence: "every morning at 9:00",
    },
    {
      id: "every-weekday",
      Icon: BriefcaseBusiness,
      label: t(($) => {
        return $.chat.composer.slashActions.scheduleEveryWeekday;
      }),
      cadence: "every weekday at 9:00",
    },
    {
      id: "every-monday",
      Icon: CalendarDays,
      label: t(($) => {
        return $.chat.composer.slashActions.scheduleEveryMonday;
      }),
      cadence: "every Monday at 9:00",
    },
    {
      id: "every-month",
      Icon: CalendarRange,
      label: t(($) => {
        return $.chat.composer.slashActions.scheduleEveryMonth;
      }),
      cadence: "on the first day of every month at 9:00",
    },
  ];
  return {
    items: presets.map((preset) => {
      return {
        id: preset.id,
        Icon: preset.Icon,
        label: preset.label,
        run: write(scheduledAutomationChatPrompt(preset.cadence)),
      };
    }),
    footer: {
      id: "custom",
      Icon: CalendarClock,
      label: t(($) => {
        return $.chat.composer.slashActions.scheduleCustom;
      }),
      run: write(CREATE_AUTOMATION_CHAT_PROMPT),
    },
  };
}

/** The actions that change how this chat runs. */
function useComposerActions(
  composer: ComposerSignals,
  leave: () => void,
): SlashAction[] {
  const { t } = useTranslation();
  const openConnectors = useSet(composer.connector.openAddConnectorsDialog$);
  const insertText = useSet(composer.editor.insertText$);
  return [
    ...useModelActions(composer, leave),
    {
      id: "connect",
      Icon: Plug,
      label: t(($) => {
        return $.chat.composer.slashActions.connect;
      }),
      hint: t(($) => {
        return $.chat.composer.slashActions.connectHint;
      }),
      keywords: ["connect", "connector", "integration"],
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
      keywords: ["schedule", "automation"],
      submenu: useScheduleSubmenu(composer, leave),
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
      keywords: ["new", "chat"],
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
      keywords: ["rename", "title"],
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
      keywords: pinned ? ["unpin"] : ["pin"],
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
      keywords: ["archive"],
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
    keywords: ["share", "link"],
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
