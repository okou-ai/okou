import { command } from "ccstate";
import type { TeamsUploadCompleteResponse } from "@okouai/api-contracts/contracts/integrations";

import { appendIntegrationMessageFooter } from "../../lib/integration-message-footer";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import { sendTeamsMessage } from "../external/teams-bot-client";
import { settle } from "../utils";
import { finalizePublishedImFile$ } from "./canonical-asset.service";
import { resolveTeamsMessageSendPresentation$ } from "./integration-message-send-presentation.service";
import { routeError } from "./teams-message-target.service";
import { resolveTeamsWriteTarget$ } from "./teams-write-access.service";
import { uploadedArtifactFetchUrl$ } from "./uploaded-artifact.service";

interface CompleteTeamsFileUploadArgs {
  readonly assetId: string;
  readonly runId: string | null;
  readonly orgId: string;
  readonly userId: string;
  readonly conversationId?: string;
  readonly user?: string;
  readonly activityId?: string;
  readonly contentType?: string;
  readonly text?: string;
}

/** Finalize the uploaded file and fire-and-forget deliver it to Teams. */
export const completeCanonicalTeamsUpload$ = command(
  async ({ set }, args: CompleteTeamsFileUploadArgs, signal: AbortSignal) => {
    const contentTypeOverride = args.contentType
      ? (args.contentType.split(";")[0]?.trim().toLowerCase() ?? "")
      : undefined;
    if (
      contentTypeOverride !== undefined &&
      !isAllowedUploadType(contentTypeOverride)
    ) {
      return routeError(
        400,
        `Unsupported Teams upload type: ${contentTypeOverride}`,
        "BAD_REQUEST",
      );
    }

    const target = await set(
      resolveTeamsWriteTarget$,
      {
        orgId: args.orgId,
        userId: args.userId,
        ...(args.runId !== null ? { runId: args.runId } : {}),
        body: {
          conversationId: args.conversationId,
          user: args.user,
          activityId: args.activityId,
        },
      },
      signal,
    );
    if ("status" in target) {
      return target;
    }

    const finalized = await set(
      finalizePublishedImFile$,
      {
        assetId: args.assetId,
        userId: args.userId,
        orgId: args.orgId,
        runId: args.runId,
        ...(contentTypeOverride !== undefined ? { contentTypeOverride } : {}),
      },
      signal,
    );
    if (!finalized.ok) {
      return routeError(
        finalized.code === "NOT_FOUND" ? 404 : 400,
        finalized.message,
        finalized.code,
      );
    }

    const fetchUrl = await set(
      uploadedArtifactFetchUrl$,
      {
        isPrivate: true,
        bucket: finalized.file.bucket,
        key: finalized.file.key,
        url: finalized.url,
      },
      signal,
    );
    const presentation = await set(
      resolveTeamsMessageSendPresentation$,
      target.installation.teamsTenantId,
      signal,
    );

    const sent = await settle(
      sendTeamsMessage(
        {
          serviceUrl: target.installation.serviceUrl,
          tenantId: target.installation.teamsTenantId,
          conversationId: target.conversationId,
          activityId: args.activityId,
          text: appendIntegrationMessageFooter(
            [args.text, `[${finalized.file.filename}](${finalized.url})`]
              .filter(Boolean)
              .join("\n\n"),
            presentation.footerText,
          ),
          ...(presentation.entities.length > 0
            ? { entities: presentation.entities }
            : {}),
          attachments: [
            {
              contentType: finalized.file.contentType,
              contentUrl: fetchUrl,
              name: finalized.file.filename,
            },
          ],
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!sent.ok || sent.value.kind === "teams-error") {
      return routeError(
        502,
        "Failed to deliver the file attachment to Microsoft Teams.",
        "TEAMS_DELIVERY_FAILED",
      );
    }

    const body: TeamsUploadCompleteResponse = {
      ...(sent.value.activityId ? { activityId: sent.value.activityId } : {}),
      conversationId: target.conversationId,
      filename: finalized.file.filename,
      mimetype: finalized.file.contentType,
      size: finalized.file.sizeBytes,
      url: finalized.url,
    };
    return { status: 200 as const, body };
  },
);
