import { command } from "ccstate";
import { literal, object, string } from "zod";
import {
  buildFeishuModelPickerMessage,
  buildFeishuNoticeMessage,
} from "../../lib/feishu-message-card";
import { integrationModelRecoveryIdentity$ } from "./integration-model-recovery-access.service";
import {
  loadIntegrationModelChoices$,
  MODEL_RECOVERY_ACTION,
  MODEL_RECOVERY_STALE,
  modelRecoveryStateSchema,
  saveIntegrationModelChoice$,
} from "./integration-model-recovery.service";

const actionSchema = object({
  operator: object({ open_id: string().min(1) }),
  context: object({ open_chat_id: string().min(1) }),
  action: object({
    value: object({
      action: literal(MODEL_RECOVERY_ACTION),
      eventId: string(),
    }).passthrough(),
    option: string().optional(),
  }),
});

/** Receives the already validated app/tenant event envelope. */
export const handleFeishuModelRecovery$ = command(
  async (
    { set },
    event: unknown,
    installationId: string,
    signal: AbortSignal,
  ): Promise<Response> => {
    const parsed = actionSchema.safeParse(event);
    if (!parsed.success) {
      return Response.json({
        toast: { type: "error", content: MODEL_RECOVERY_STALE },
      });
    }
    const action = parsed.data;
    const identity = await set(
      integrationModelRecoveryIdentity$,
      {
        channel: "feishu",
        eventId: action.action.value.eventId,
        platformUserId: action.operator.open_id,
        conversationId: action.context.open_chat_id,
        installationId,
      },
      signal,
    );
    const recovery = identity
      ? await set(loadIntegrationModelChoices$, identity, signal)
      : null;
    if (!identity || !recovery) {
      return Response.json({
        toast: { type: "error", content: MODEL_RECOVERY_STALE },
      });
    }
    if (action.action.option !== undefined) {
      const state = modelRecoveryStateSchema.safeParse(action.action.value);
      const text = state.success
        ? await set(
            saveIntegrationModelChoice$,
            {
              ...identity,
              model: action.action.option,
              expectedModelState: state.data,
            },
            signal,
          )
        : MODEL_RECOVERY_STALE;
      return Response.json({
        card: {
          type: "raw",
          data: buildFeishuNoticeMessage({ title: "Model selection", text })
            .content,
        },
      });
    }
    return Response.json({
      card: {
        type: "raw",
        data: buildFeishuModelPickerMessage(recovery).content,
      },
    });
  },
);
