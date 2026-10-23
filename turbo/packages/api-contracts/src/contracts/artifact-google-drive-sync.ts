import * as z from "zod";

export const chatThreadArtifactGoogleDriveRecoverySchema = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("authorize") }),
    z.object({ action: z.literal("connect") }),
    z.object({
      action: z.literal("reconnect"),
      connectionId: z.uuid(),
    }),
    z.object({ action: z.literal("unavailable") }),
  ],
);

const chatThreadArtifactGoogleDriveAccountReadyShape = {
  /**
   * Emitted after the thread account, credentials, and agent authorization
   * resolve. The disconnected variant carries no readiness marker.
   */
  accountReady: z.literal(true),
};

export const chatThreadArtifactGoogleDriveSyncSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("synced"),
      ...chatThreadArtifactGoogleDriveAccountReadyShape,
      id: z.string(),
      name: z.string(),
      webViewLink: z.string().nullable(),
      mimeType: z.string().optional(),
      originalUploaded: z.boolean().optional(),
    }),
    z.object({
      status: z.literal("not_synced"),
      ...chatThreadArtifactGoogleDriveAccountReadyShape,
    }),
    z.object({
      status: z.literal("disconnected"),
      recovery: chatThreadArtifactGoogleDriveRecoverySchema,
    }),
    z.object({
      status: z.literal("unknown"),
      ...chatThreadArtifactGoogleDriveAccountReadyShape,
    }),
  ],
);

export type ChatThreadArtifactGoogleDriveSync = z.infer<
  typeof chatThreadArtifactGoogleDriveSyncSchema
>;
export type ChatThreadArtifactGoogleDriveRecovery = z.infer<
  typeof chatThreadArtifactGoogleDriveRecoverySchema
>;
