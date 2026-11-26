import {
  discriminatedUnion,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as Infer,
} from "zod";
import { chatThreadArtifactGoogleDriveSyncSchema } from "./artifact-google-drive-sync";

/** Links identify the selected resource. The content reader authorizes byte access. */
export const messageArtifactDetailSchema = object({
  url: string(),
  filename: string(),
  contentType: string(),
  size: number().optional(),
  preview: discriminatedUnion("kind", [
    object({
      kind: literal("image"),
      imageUrl: string(),
      thumbnailUrl: string().optional(),
    }),
    object({
      kind: literal("video"),
      playbackUrl: string(),
      posterUrl: string().optional(),
    }),
    object({ kind: literal("audio"), playbackUrl: string() }),
    object({
      kind: zEnum(["website", "presentation-html"]),
      pageUrl: string(),
      aliasUrl: string().optional(),
      coverUrl: string().optional(),
    }),
    object({
      kind: literal("html"),
      pageUrl: string(),
      coverUrl: string().optional(),
    }),
    object({
      kind: zEnum(["markdown", "text", "json", "csv", "pdf", "file"]),
      fileUrl: string(),
    }),
  ]),
  owner: object({
    fileId: string(),
    publicationId: uuid(),
    artifactId: uuid().optional(),
    createdAt: string(),
    title: string().optional(),
  }).optional(),
});
export type MessageArtifactDetail = Infer<typeof messageArtifactDetailSchema>;

export const messageArtifactDriveStatusSchema = object({
  googleDriveConnectionId: uuid().optional(),
  googleDriveSync: chatThreadArtifactGoogleDriveSyncSchema,
});
