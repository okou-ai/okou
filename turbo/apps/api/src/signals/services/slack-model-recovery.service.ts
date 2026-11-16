import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { array, literal, object, string } from "zod";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { db$ } from "../external/db";
import { createSlackClient } from "../external/slack-message-client";
import type { SlackView } from "../external/slack-block-kit";
import { safeJsonParse, settle } from "../utils";
import { waitUntil } from "../context/wait-until";
import { logger } from "../../lib/log";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { integrationModelRecoveryIdentity$ } from "./integration-model-recovery-access.service";
import {
  MODEL_RECOVERY_ACTION,
  MODEL_RECOVERY_STALE,
  loadIntegrationModelChoices$,
  modelRecoveryStateSchema,
  saveIntegrationModelChoice$,
} from "./integration-model-recovery.service";

const base = object({
  user: object({ id: string() }),
  team: object({ id: string() }),
});
const openSchema = base.extend({
  type: literal("block_actions"),
  trigger_id: string(),
  channel: object({ id: string() }),
  actions: array(object({ action_id: string(), value: string().optional() })),
});
const submissionSchema = base.extend({
  type: literal("view_submission"),
  view: object({
    callback_id: literal(MODEL_RECOVERY_ACTION),
    private_metadata: string(),
    state: object({
      values: object({
        model: object({
          selection: object({ selected_option: object({ value: string() }) }),
        }),
      }),
    }),
  }),
});
const metadataSchema = modelRecoveryStateSchema.extend({
  channelId: string().min(1),
});

function noticeView(text: string): SlackView {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Switch model" },
    close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "plain_text", text } }],
  };
}

/** The caller has already verified the Slack request signature. */
export const handleSlackModelRecovery$ = command(
  async (
    { get, set },
    payload: unknown,
    signal: AbortSignal,
  ): Promise<Response | null> => {
    const submission = submissionSchema.safeParse(payload);
    if (submission.success) {
      const metadata = metadataSchema.safeParse(
        safeJsonParse(submission.data.view.private_metadata),
      );
      if (!metadata.success) {
        return Response.json({
          response_action: "errors",
          errors: { model: MODEL_RECOVERY_STALE },
        });
      }
      const identity = await set(
        integrationModelRecoveryIdentity$,
        {
          channel: "slack",
          eventId: metadata.data.eventId,
          platformUserId: submission.data.user.id,
          workspaceId: submission.data.team.id,
          conversationId: metadata.data.channelId,
        },
        signal,
      );
      const message = identity
        ? await set(
            saveIntegrationModelChoice$,
            {
              ...identity,
              model:
                submission.data.view.state.values.model.selection
                  .selected_option.value,
              expectedModelState: metadata.data,
            },
            signal,
          )
        : MODEL_RECOVERY_STALE;
      return Response.json({
        response_action: "update",
        view: noticeView(message),
      });
    }
    const opened = openSchema.safeParse(payload);
    if (!opened.success) {
      return null;
    }
    const action = opened.data.actions.find((item) => {
      return item.action_id === MODEL_RECOVERY_ACTION;
    });
    if (!action?.value) {
      return null;
    }
    const [installation] = await get(db$)
      .select({
        encryptedBotToken: slackOrgInstallations.encryptedBotToken,
        orgId: slackOrgInstallations.orgId,
      })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, opened.data.team.id))
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return Response.json({});
    }
    const botToken = await decryptPersistentSecretValue(
      installation.encryptedBotToken,
      { orgId: installation.orgId ?? undefined },
    );
    signal.throwIfAborted();
    const client = createSlackClient(botToken);
    // Consume Slack's short-lived trigger before membership/catalog I/O.
    const openedView = await client.openView(
      opened.data.trigger_id,
      noticeView("Loading models…"),
    );
    signal.throwIfAborted();
    if (openedView.viewId) {
      waitUntil(
        set(
          populateSlackModelRecovery$,
          {
            opened: opened.data,
            eventId: action.value,
            botToken,
            viewId: openedView.viewId,
          },
          signal,
        ),
      );
    }
    return Response.json({});
  },
);

const populateSlackModelRecovery$ = command(
  async (
    { set },
    args: {
      readonly opened: typeof openSchema._output;
      readonly eventId: string;
      readonly botToken: string;
      readonly viewId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const opened = { data: args.opened };
    const action = { value: args.eventId };
    const result = await settle(
      (async () => {
        const identity = await set(
          integrationModelRecoveryIdentity$,
          {
            channel: "slack",
            eventId: action.value,
            platformUserId: opened.data.user.id,
            workspaceId: opened.data.team.id,
            conversationId: opened.data.channel.id,
          },
          signal,
        );
        const recovery = identity
          ? await set(loadIntegrationModelChoices$, identity, signal)
          : null;
        let view = noticeView(MODEL_RECOVERY_STALE);
        if (recovery) {
          const options = recovery.choices.slice(0, 100).map((choice) => {
            return {
              text: {
                type: "plain_text" as const,
                text: choice.label.slice(0, 75),
              },
              value: choice.value,
              description: {
                type: "plain_text" as const,
                text: choice.description,
              },
            };
          });
          const selected = options.find((option) => {
            return option.value === recovery.selectedModel;
          });
          view = {
            type: "modal",
            callback_id: MODEL_RECOVERY_ACTION,
            title: { type: "plain_text", text: "Switch model" },
            submit: { type: "plain_text", text: "Save" },
            close: { type: "plain_text", text: "Cancel" },
            private_metadata: JSON.stringify({
              eventId: recovery.eventId,
              selectedModel: recovery.selectedModel,
              updatedAt: recovery.updatedAt,
              channelId: opened.data.channel.id,
            }),
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `Current model: *${recovery.currentModelLabel}*\nThis changes only this conversation. Send your previous request again after saving.`,
                },
              },
              {
                type: "input",
                block_id: "model",
                label: { type: "plain_text", text: "Model" },
                element: {
                  type: "static_select",
                  action_id: "selection",
                  options,
                  ...(selected ? { initial_option: selected } : {}),
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `<${recovery.url}|Open this conversation in Okou>`,
                },
              },
            ],
          };
        }
        return view;
      })(),
      signal,
    );
    if (!result.ok) {
      logger("SlackModelRecovery").warn("Could not load model selector", {
        error: result.error,
      });
    }
    await createSlackClient(args.botToken).updateView(
      args.viewId,
      result.ok
        ? result.value
        : noticeView(
            "Models could not be loaded. Close this window and try again.",
          ),
    );
    signal.throwIfAborted();
  },
);
