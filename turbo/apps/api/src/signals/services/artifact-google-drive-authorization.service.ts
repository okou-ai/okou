import { command } from "ccstate";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  artifacts,
  imageArtifacts,
  presentationArtifacts,
} from "@okouai/db/schema/artifact";
import { files } from "@okouai/db/schema/file";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";

import { db$, writeDb$ } from "../external/db";
import {
  chatConnectorExecutionFromRows,
  chatConnectorExecutionReadPlan,
} from "./chat-connector-execution";
import { resolveFileUrl$ } from "./private-artifact-storage.service";

export type DriveConnectorAccountResolution =
  | { readonly type: "resolved"; readonly connectorId: string }
  | { readonly type: "connect" }
  | { readonly type: "unavailable" };

export const chatGoogleDriveAccount$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly connectionId?: string;
      readonly runId?: string;
    },
    signal: AbortSignal,
  ): Promise<DriveConnectorAccountResolution> => {
    const { orgId, userId, threadId, runId } = args;
    const rows = await set(writeDb$)
      .select()
      .from(
        chatConnectorExecutionReadPlan(
          runId
            ? { kind: "run", runId, orgId, userId }
            : { kind: "chat", chatThreadId: threadId, orgId, userId },
          "google-drive",
        ).as("drive_chat_accounts"),
      );
    signal.throwIfAborted();
    if (!rows.length) {
      return !runId && (await set(ownedGoogleDriveThreadContext$, args, signal))
        ? { type: "connect" }
        : { type: "unavailable" };
    }
    const [current] = chatConnectorExecutionFromRows(rows).selections;
    if (
      rows[0]?.chatThreadId !== threadId ||
      !current ||
      (args.connectionId && args.connectionId !== current.connectionId)
    ) {
      return { type: "unavailable" };
    }
    return { type: "resolved", connectorId: current.connectionId };
  },
);

/** Validate the current view before using its account or agent context. */
export const ownedGoogleDriveThreadContext$ = command(
  async (
    { get },
    args: {
      readonly threadId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const [thread] = await get(db$)
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.orgId, args.orgId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return thread !== undefined;
  },
);

export interface OwnedGoogleDriveArtifact {
  readonly runId: string | null;
  readonly threadId: string | null;
  readonly source: string;
  readonly externalId: string;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly url: string | null;
  readonly metadata: Record<string, unknown>;
}

const resolveHostedDriveArtifact$ = command(
  async (
    { set },
    args: {
      readonly siteId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string | null;
      readonly title: string;
      readonly defaultArtifactKind: "hosted-site" | "presentation-html";
    },
    signal: AbortSignal,
  ): Promise<OwnedGoogleDriveArtifact | null> => {
    const db = set(writeDb$);
    const [site] = await db
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.id, args.siteId),
          eq(hostedSites.orgId, args.orgId),
          eq(hostedSites.userId, args.userId),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!site) {
      return null;
    }
    const [publicDep] = site.activeDeploymentId
      ? await db
          .select()
          .from(hostedDeployments)
          .where(
            and(
              eq(hostedDeployments.id, site.activeDeploymentId),
              eq(hostedDeployments.siteId, site.id),
              eq(hostedDeployments.status, "ready"),
            ),
          )
          .limit(1)
      : [];
    signal.throwIfAborted();
    const [privateDep] = !publicDep
      ? await db
          .select()
          .from(privateHostedDeployments)
          .where(
            and(
              eq(privateHostedDeployments.siteId, site.id),
              eq(privateHostedDeployments.orgId, args.orgId),
              eq(privateHostedDeployments.userId, args.userId),
              eq(privateHostedDeployments.status, "ready"),
            ),
          )
          .orderBy(desc(privateHostedDeployments.createdAt))
          .limit(1)
      : [];
    signal.throwIfAborted();
    const deployment = publicDep ?? privateDep;
    if (!deployment) {
      return null;
    }
    const artifactKind =
      deployment.manifest.artifactKind ?? args.defaultArtifactKind;
    return {
      runId: deployment.runId,
      threadId: args.threadId,
      source: "hosted",
      externalId: deployment.id,
      filename: `${args.title}.html`,
      contentType: "text/html",
      url: deployment.artifactUrl ?? deployment.url,
      metadata: {
        artifactKind,
        deploymentId: deployment.id,
        siteId: site.id,
        ...(deployment.manifest.access
          ? { access: deployment.manifest.access }
          : {}),
      },
    };
  },
);

const ownedDriveFileById$ = command(
  async (
    { set },
    args: {
      readonly fileId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string | null;
      readonly sourceUrl?: string | null;
    },
    signal: AbortSignal,
  ): Promise<OwnedGoogleDriveArtifact | null> => {
    const [file] = await set(writeDb$)
      .select()
      .from(files)
      .where(
        and(
          eq(files.id, args.fileId),
          eq(files.orgId, args.orgId),
          eq(files.ownerUserId, args.userId),
          isNull(files.deletedAt),
          isNotNull(files.sizeBytes),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!file?.storageKey || !file.filename) {
      return null;
    }
    const url =
      args.sourceUrl ??
      (await set(
        resolveFileUrl$,
        { id: file.id, storageKey: file.storageKey, filename: file.filename },
        signal,
      ));
    return {
      runId: null,
      threadId: args.threadId,
      source: "web",
      externalId: file.id,
      filename: file.filename,
      contentType: file.contentType,
      url,
      metadata: {},
    };
  },
);

const ownedDriveCatalogArtifact$ = command(
  async (
    { set },
    args: {
      readonly artifact: typeof artifacts.$inferSelect;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<OwnedGoogleDriveArtifact | null> => {
    const db = set(writeDb$);
    const { artifact } = args;
    if (artifact.kind === "hosted-site" || artifact.kind === "presentation") {
      let siteId = artifact.entityId;
      if (artifact.kind === "presentation") {
        const [presentation] = await db
          .select({ hostedSiteId: presentationArtifacts.hostedSiteId })
          .from(presentationArtifacts)
          .where(eq(presentationArtifacts.id, artifact.entityId))
          .limit(1);
        signal.throwIfAborted();
        if (!presentation) {
          return null;
        }
        siteId = presentation.hostedSiteId;
      }
      return await set(
        resolveHostedDriveArtifact$,
        {
          siteId,
          orgId: args.orgId,
          userId: args.userId,
          threadId: artifact.chatThreadId,
          title: artifact.title,
          defaultArtifactKind:
            artifact.kind === "presentation"
              ? "presentation-html"
              : "hosted-site",
        },
        signal,
      );
    }

    let fileId: string | null = artifact.entityId;
    if (artifact.kind === "image") {
      const [image] = await db
        .select({ fileId: imageArtifacts.fileId })
        .from(imageArtifacts)
        .where(eq(imageArtifacts.id, artifact.entityId))
        .limit(1);
      signal.throwIfAborted();
      fileId = image?.fileId ?? null;
    }
    if (!fileId) {
      return null;
    }
    return await set(
      ownedDriveFileById$,
      {
        fileId,
        orgId: args.orgId,
        userId: args.userId,
        threadId: artifact.chatThreadId,
        sourceUrl: artifact.sourceUrl,
      },
      signal,
    );
  },
);

/** Authorize the stored resource via `artifacts`, `files`, and `hosted_sites` (zero legacy table reads). */
export const ownedGoogleDriveArtifact$ = command(
  async (
    { set },
    args: {
      readonly artifactId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly catalogOnly?: boolean;
    },
    signal: AbortSignal,
  ): Promise<OwnedGoogleDriveArtifact | null> => {
    const db = set(writeDb$);
    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, args.artifactId),
          eq(artifacts.orgId, args.orgId),
          eq(artifacts.authorUserId, args.userId),
          isNull(artifacts.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (artifact) {
      return await set(
        ownedDriveCatalogArtifact$,
        { artifact, orgId: args.orgId, userId: args.userId },
        signal,
      );
    }

    if (args.catalogOnly) {
      return null;
    }

    const directFile = await set(
      ownedDriveFileById$,
      {
        fileId: args.artifactId,
        orgId: args.orgId,
        userId: args.userId,
        threadId: null,
      },
      signal,
    );
    if (directFile) {
      return directFile;
    }

    const [deployment] = await db
      .select({
        siteId: hostedDeployments.siteId,
        manifest: hostedDeployments.manifest,
      })
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, args.artifactId),
          eq(hostedDeployments.orgId, args.orgId),
          eq(hostedDeployments.userId, args.userId),
          eq(hostedDeployments.status, "ready"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!deployment) {
      return null;
    }
    return await set(
      resolveHostedDriveArtifact$,
      {
        siteId: deployment.siteId,
        orgId: args.orgId,
        userId: args.userId,
        threadId: null,
        title: deployment.manifest.title ?? deployment.manifest.publicSlug,
        defaultArtifactKind: deployment.manifest.artifactKind ?? "hosted-site",
      },
      signal,
    );
  },
);
