import {
  discriminatedUnion,
  object,
  literal,
  uuid,
  string,
  boolean,
  type infer as Infer,
} from "zod";

export const chatThreadArtifactGoogleDriveRecoverySchema = discriminatedUnion(
  "action",
  [
    object({ action: literal("authorize") }),
    object({ action: literal("connect") }),
    object({
      action: literal("reconnect"),
      connectionId: uuid(),
    }),
    object({ action: literal("unavailable") }),
  ],
);

const chatThreadArtifactGoogleDriveAccountReadyShape = {
  /**
   * Emitted after the thread account, credentials, and agent authorization
   * resolve. The disconnected variant carries no readiness marker.
   */
  accountReady: literal(true),
};

export const chatThreadArtifactGoogleDriveSyncSchema = discriminatedUnion(
  "status",
  [
    object({
      status: literal("synced"),
      ...chatThreadArtifactGoogleDriveAccountReadyShape,
      id: string(),
      name: string(),
      webViewLink: string().nullable(),
      mimeType: string().optional(),
      originalUploaded: boolean().optional(),
    }),
    object({
      status: literal("not_synced"),
      ...chatThreadArtifactGoogleDriveAccountReadyShape,
    }),
    object({
      status: literal("disconnected"),
      recovery: chatThreadArtifactGoogleDriveRecoverySchema,
    }),
    object({
      status: literal("unknown"),
      ...chatThreadArtifactGoogleDriveAccountReadyShape,
    }),
  ],
);

export type ChatThreadArtifactGoogleDriveSync = Infer<
  typeof chatThreadArtifactGoogleDriveSyncSchema
>;
export type ChatThreadArtifactGoogleDriveRecovery = Infer<
  typeof chatThreadArtifactGoogleDriveRecoverySchema
>;
