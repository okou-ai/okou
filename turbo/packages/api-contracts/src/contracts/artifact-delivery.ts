import {
  discriminatedUnion,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { linkLayoutSegmentSchema, type LinkLayoutSegment } from "./link-layout";

// `publicBrand` is the persisted link-layout marker. Deployed delivery Workers
// compare it with the layout segment of the key they read, so its name and
// values are part of the stored R2 format.
export const artifactDeliveryRecordSchema = discriminatedUnion("kind", [
  // A separate discriminator makes older Workers reject this delivery instead
  // of ignoring the shared conversation's additional authorization boundary.
  object({
    version: literal(1),
    kind: literal("thread-resource"),
    publicBrand: linkLayoutSegmentSchema,
    threadId: uuid(),
    publicToken: string().regex(/^(?:[a-z0-9]{10}|[a-f0-9]{24})$/u),
    targetKind: zEnum(["file", "html"]),
    // New registrations bind the alias to one resource before publication.
    targetId: uuid().optional(),
  }),
  object({
    version: literal(1),
    kind: literal("publication"),
    publicBrand: linkLayoutSegmentSchema,
    shareId: uuid(),
    publicToken: string().regex(/^(?:[a-z0-9]{10}|[a-f0-9]{24})$/u),
    targetKind: zEnum(["file", "html"]),
  }),
  object({
    version: literal(1),
    kind: literal("legacy-file"),
    publicBrand: linkLayoutSegmentSchema,
    audience: literal("public"),
    key: string().startsWith("artifacts/"),
    filename: string().min(1),
    contentType: string().min(1),
  }),
  object({
    version: literal(1),
    kind: literal("legacy-site"),
    publicBrand: linkLayoutSegmentSchema,
    audience: literal("public"),
    pointerKey: string().startsWith("sites/"),
  }),
]);
export type ArtifactDeliveryRecord = zInfer<
  typeof artifactDeliveryRecordSchema
>;

export function artifactDeliveryKey(
  segment: LinkLayoutSegment | null,
  kind: "file" | "html",
  alias: string,
): string {
  // One file hostname spans both layouts, so file aliases have one namespace.
  if (kind === "file")
    return `artifact-delivery/files/${encodeURIComponent(alias)}.json`;
  if (!segment)
    throw new Error("A hosted artifact registry key requires a link layout");
  return `artifact-delivery/${segment}/html/${encodeURIComponent(alias)}.json`;
}

export function artifactFilenameExtension(filename: string): string {
  return filename.toLowerCase().match(/\.[a-z0-9]{1,12}$/u)?.[0] ?? ".bin";
}

/** Only the old 24-character shape unambiguously identifies a publication. */
export function isArtifactPublicationFilePath(pathname: string): boolean {
  return /^\/[a-f0-9]{24}\.[a-z0-9]{1,12}$/u.test(pathname);
}

/** Ten-character names require the delivery registry to distinguish old files from shares. */
export function isArtifactDeliveryFilePath(pathname: string): boolean {
  return /^\/(?:[a-z0-9]{10}|[a-f0-9]{24})\.[a-z0-9]{1,12}$/u.test(pathname);
}

/** The marker certifies completed registration, not a feature rollout flag. */
export function artifactDeliveryRegistrationKey(
  segment: LinkLayoutSegment,
): string {
  return `artifact-delivery/${segment}/registration.json`;
}
