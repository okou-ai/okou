import { waitUntil } from "../context/wait-until";
import { continueIntegrationRecovery$ } from "./integration-recovery-continuation.service";
import { command } from "ccstate";
import { literal, object, string, enum as zEnum } from "zod";
import { integrationModelRecoveryIdentity$ } from "./integration-model-recovery-access.service";
import {
  loadIntegrationModelChoices$,
  MODEL_RECOVERY_ACTION,
  MODEL_RECOVERY_STALE,
  modelRecoveryStateSchema,
  saveIntegrationModelChoice$,
} from "./integration-model-recovery.service";

const invokeSchema = object({
  type: literal("invoke"),
  name: zEnum(["task/fetch", "task/submit"]),
  from: object({
    id: string().min(1),
    aadObjectId: string().min(1).optional(),
  }),
  conversation: object({ id: string().min(1) }),
  channelData: object({ tenant: object({ id: string().min(1) }) }),
  value: object({
    data: object({
      action: literal(MODEL_RECOVERY_ACTION),
      eventId: string(),
    }).passthrough(),
  }),
});
const submitSchema = modelRecoveryStateSchema.extend({
  model: string().min(1),
});

/** The Bot Framework token is verified by the owning route before this call. */
export const handleTeamsModelRecovery$ = command(
  async (
    { set },
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response | null> => {
    const parsed = invokeSchema.safeParse(body);
    if (!parsed.success) {
      return null;
    }
    const activity = parsed.data;
    const identity = await set(
      integrationModelRecoveryIdentity$,
      {
        channel: "teams",
        eventId: activity.value.data.eventId,
        platformUserId: activity.from.id,
        aadObjectId: activity.from.aadObjectId,
        conversationId: activity.conversation.id,
        workspaceId: activity.channelData.tenant.id,
      },
      signal,
    );
    const recovery = identity
      ? await set(loadIntegrationModelChoices$, identity, signal)
      : null;
    if (!identity || !recovery) {
      return Response.json({
        task: { type: "message", value: MODEL_RECOVERY_STALE },
      });
    }
    if (activity.name === "task/submit") {
      const selection = submitSchema.safeParse(activity.value.data);
      const saved = selection.success
        ? await set(
            saveIntegrationModelChoice$,
            {
              ...identity,
              model: selection.data.model,
              expectedModelState: selection.data,
            },
            signal,
          )
        : { message: MODEL_RECOVERY_STALE, input: null };
      if (saved.input) {
        waitUntil(set(continueIntegrationRecovery$, saved.input, signal));
      }
      return Response.json({ task: { type: "message", value: saved.message } });
    }
    return Response.json({
      task: {
        type: "continue",
        value: {
          title: "Switch model",
          height: "medium",
          width: "medium",
          card: {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                {
                  type: "TextBlock",
                  text: `Current model: ${recovery.currentModelLabel}. This changes only this conversation and automatically continues your previous request.`,
                  wrap: true,
                },
                {
                  type: "Input.ChoiceSet",
                  id: "model",
                  label: "Model",
                  isRequired: true,
                  errorMessage: "Select a model",
                  choices: recovery.choices.map((choice) => {
                    return {
                      title: `${choice.label} — ${choice.description}`,
                      value: choice.value,
                    };
                  }),
                  value: recovery.selectedModel,
                },
              ],
              actions: [
                {
                  type: "Action.Submit",
                  title: "Save",
                  data: {
                    action: MODEL_RECOVERY_ACTION,
                    eventId: recovery.eventId,
                    selectedModel: recovery.selectedModel,
                    updatedAt: recovery.updatedAt,
                  },
                },
                {
                  type: "Action.OpenUrl",
                  title: "Open conversation",
                  url: recovery.url,
                },
              ],
            },
          },
        },
      },
    });
  },
);
