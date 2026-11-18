import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import {
  FeishuApiError,
  feishuReactionCreationUrl,
  feishuTokenUpdateValues,
  parseFeishuReactionCreationResponse,
  readFeishuResponseJson,
  resolveFeishuRequestCredentials$,
} from "../external/feishu-client";
import { tapError } from "../utils";
import {
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "./feishu-config";

const feishuDispatchL = logger("FeishuDispatch");
const FEISHU_THINKING_EMOJI = "Typing";

export const addFeishuThinkingReaction$ = command(
  async (
    { set },
    message: { readonly installationId: string; readonly messageId: string },
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    const db = set(writeDb$);
    const creationArgs = {
      installationId: message.installationId,
      messageId: message.messageId,
      emojiType: FEISHU_THINKING_EMOJI,
    };
    const creationSignal = signal;
    const createdReactionId = await tapError(
      (async () => {
        const addReactionContextArgs = creationArgs;
        const addReactionContextSignal = creationSignal;
        const { token, apiOrigin, providerName } = await (async () => {
          const [installation] = await db
            .select()
            .from(feishuOrgInstallations)
            .where(
              eq(
                feishuOrgInstallations.id,
                addReactionContextArgs.installationId,
              ),
            )
            .limit(1);
          addReactionContextSignal.throwIfAborted();
          if (!installation) {
            throw new Error("Bot installation not found");
          }
          if (
            !(await (async () => {
              const plan = feishuInstallationAvailabilityReadPlan(installation);
              if (plan.kind === "resolved") {
                return plan.enabled;
              }
              const rows = await db
                .select(plan.columns)
                .from(userFeatureSwitches)
                .where(plan.condition);
              return feishuInstallationEnabledFromRows(plan.scope, rows);
            })())
          ) {
            throw new FeishuApiError("Lark integration is not enabled", 403);
          }
          const credentials = await set(
            resolveFeishuRequestCredentials$,
            installation,
            addReactionContextSignal,
          );
          if (credentials.refreshedToken) {
            await db
              .update(feishuOrgInstallations)
              .set(feishuTokenUpdateValues(credentials.refreshedToken))
              .where(
                eq(
                  feishuOrgInstallations.id,
                  addReactionContextArgs.installationId,
                ),
              );
            addReactionContextSignal.throwIfAborted();
          }
          return credentials.context;
        })();
        const response = fetch(
          feishuReactionCreationUrl(apiOrigin, creationArgs.messageId),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json; charset=utf-8",
            },
            body: JSON.stringify({
              reaction_type: { emoji_type: creationArgs.emojiType },
            }),
          },
        );
        return parseFeishuReactionCreationResponse(
          await readFeishuResponseJson(response, providerName),
          providerName,
        );
      })(),
      (error) => {
        feishuDispatchL.warn("Failed to set Feishu thinking indicator", {
          error,
          messageId: message.messageId,
        });
      },
    );
    signal.throwIfAborted();
    return createdReactionId;
  },
);
