import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { sameSelectedModel } from "@okouai/core/auto-run-model";
import type { ChatEventGroup } from "./chat-event.ts";
import { asInputChatEvent } from "./chat-event-display.ts";
import type { ChatRunModelSelection } from "./chat-event-state.ts";
import type { ChatInputEvent } from "./chat-event-types.ts";

function modelSelectionFromUserMessage(
  document: UserMessageDocument | undefined,
): ChatRunModelSelection | undefined {
  const modelPart = document?.parts.find((part) => {
    return part.type === "model";
  });
  return modelPart?.type === "model"
    ? {
        selectedModel: modelPart.selectedModel,
        ...(modelPart.serviceTier === undefined
          ? {}
          : { serviceTier: modelPart.serviceTier }),
      }
    : undefined;
}

function modelChangeRunKey(
  inputEvent: ChatInputEvent,
  modelSelection: ChatRunModelSelection | undefined,
): string | undefined {
  if (inputEvent.runId !== undefined) {
    return `run:${inputEvent.runId}`;
  }
  if (modelSelection !== undefined) {
    return `event:${inputEvent.id}`;
  }
  return undefined;
}

export type RunModelChange =
  | {
      readonly kind: "model";
      readonly selection: ChatRunModelSelection;
    }
  | {
      readonly kind: "fast-mode";
      readonly enabled: boolean;
    };

export function fastModeEnabled(selection: ChatRunModelSelection): boolean {
  return selection.serviceTier === "priority";
}

export function modelChangesByEventId(
  groups: readonly ChatEventGroup[],
): ReadonlyMap<string, RunModelChange> {
  const changes = new Map<string, RunModelChange>();
  let previousRunKey: string | undefined;
  let previousSelection: ChatRunModelSelection | undefined;
  let hasPreviousRun = false;

  for (const group of groups) {
    for (const event of group.events) {
      const inputEvent = asInputChatEvent(event);
      if (inputEvent === undefined) {
        continue;
      }
      const selection = modelSelectionFromUserMessage(inputEvent.userMessage);
      const runKey = modelChangeRunKey(inputEvent, selection);
      if (runKey === undefined || runKey === previousRunKey) {
        continue;
      }
      if (
        hasPreviousRun &&
        previousSelection !== undefined &&
        selection !== undefined
      ) {
        if (
          !sameSelectedModel(
            selection.selectedModel,
            previousSelection.selectedModel,
          )
        ) {
          changes.set(event.id, { kind: "model", selection });
        } else if (
          fastModeEnabled(selection) !== fastModeEnabled(previousSelection)
        ) {
          changes.set(event.id, {
            kind: "fast-mode",
            enabled: fastModeEnabled(selection),
          });
        }
      }
      previousRunKey = runKey;
      previousSelection = selection;
      hasPreviousRun = true;
    }
  }

  return changes;
}

export function sameRunModelChange(
  previous: RunModelChange,
  next: RunModelChange,
): boolean {
  if (previous.kind === "model" && next.kind === "model") {
    return (
      previous.selection.selectedModel === next.selection.selectedModel &&
      previous.selection.serviceTier === next.selection.serviceTier
    );
  }
  if (previous.kind === "fast-mode" && next.kind === "fast-mode") {
    return previous.enabled === next.enabled;
  }
  return false;
}
