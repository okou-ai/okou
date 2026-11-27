import { command } from "ccstate";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { artifactFileShares } from "@okouai/db/schema/artifact-file-share";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import type { HostedSiteShareAccount } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import artifactInvitationTemplate from "../../lib/artifact-invitation-template.json";
import type { ArtifactSharingResource } from "./artifact-sharing-resource.service";
import {
  deleteArtifactUserShareByFileId$,
  syncArtifactUserShareByFileId$,
} from "./artifact-access-dual-write.service";

export const shareFileArtifact$ = command(
  async (
    { get, set },
    args: {
      readonly resource: ArtifactSharingResource;
      readonly email: string;
      readonly recipient: HostedSiteShareAccount | undefined;
    },
    signal: AbortSignal,
  ) => {
    if (args.recipient?.userId === args.resource.userId) {
      return { status: "self" as const };
    }
    const inviter = await findClerkUser(
      get(clerk$),
      args.resource.userId,
      signal,
    );
    const database = set(writeDb$);
    const [share] = await database
      .insert(artifactFileShares)
      .values({
        fileId: args.resource.id,
        email: args.email,
        userId: args.recipient?.userId ?? null,
      })
      .onConflictDoUpdate({
        target: [artifactFileShares.fileId, artifactFileShares.email],
        set: {
          email: args.email,
          userId: sql`COALESCE(${artifactFileShares.userId}, ${args.recipient?.userId ?? null})`,
        },
      })
      .returning({
        id: artifactFileShares.id,
        email: artifactFileShares.email,
        userId: artifactFileShares.userId,
      });
    signal.throwIfAborted();
    if (!share) {
      throw new Error("Artifact sharing did not return its grant");
    }
    if (share.userId) {
      await set(
        syncArtifactUserShareByFileId$,
        {
          fileId: args.resource.id,
          userId: share.userId,
          email: share.email,
        },
        signal,
      );
    }
    await database
      .insert(emailOutbox)
      .values({
        id: share.id,
        fromAddress: artifactInvitationTemplate.from,
        toAddresses: args.email,
        subject: "You’re invited to view a file on Okou",
        template: {
          template: "artifact-invitation",
          props: {
            inviterName:
              [inviter?.firstName, inviter?.lastName]
                .filter(Boolean)
                .join(" ") || "An Okou user",
            email: args.email,
            artifactUrl: args.resource.url,
          },
        },
        createdAt: nowDate(),
      })
      .onConflictDoNothing({ target: emailOutbox.id });
    signal.throwIfAborted();
    return {
      status: "ok" as const,
      share: { id: share.id, email: share.email },
      outboxId: share.id,
    };
  },
);

export const removeFileArtifactShare$ = command(
  async (
    { set },
    args: {
      readonly resource: ArtifactSharingResource;
      readonly shareId: string;
    },
    signal: AbortSignal,
  ) => {
    const database = set(writeDb$);
    const [removed] = await database
      .delete(artifactFileShares)
      .where(
        and(
          eq(artifactFileShares.id, args.shareId),
          eq(artifactFileShares.fileId, args.resource.id),
          exists(
            database
              .select({ id: runUploadedFiles.id })
              .from(runUploadedFiles)
              .where(
                and(
                  eq(runUploadedFiles.id, args.resource.id),
                  eq(runUploadedFiles.userId, args.resource.userId),
                  eq(runUploadedFiles.orgId, args.resource.orgId),
                  isNull(runUploadedFiles.deletedAt),
                ),
              ),
          ),
        ),
      )
      .returning({
        id: artifactFileShares.id,
        userId: artifactFileShares.userId,
      });
    signal.throwIfAborted();
    if (removed?.userId) {
      await set(
        deleteArtifactUserShareByFileId$,
        { fileId: args.resource.id, userId: removed.userId },
        signal,
      );
    }
    return removed ? { id: removed.id } : null;
  },
);
