import { z } from "zod";

const brandSchema = z.enum(["vm0", "okou"]);
export const artifactDeliveryRecordSchema = z.discriminatedUnion("kind", [
  // A separate discriminator makes older Workers reject this delivery instead
  // of ignoring the shared conversation's additional authorization boundary.
  z.object({
    version: z.literal(1),
    kind: z.literal("thread-resource"),
    publicBrand: brandSchema,
    threadId: z.uuid(),
    publicToken: z.string().regex(/^(?:[a-z0-9]{10}|[a-f0-9]{24})$/u),
    targetKind: z.enum(["file", "html"]),
    // New registrations bind the alias to one resource before publication.
    targetId: z.uuid().optional(),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("publication"),
    publicBrand: brandSchema,
    shareId: z.uuid(),
    publicToken: z.string().regex(/^(?:[a-z0-9]{10}|[a-f0-9]{24})$/u),
    targetKind: z.enum(["file", "html"]),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("legacy-file"),
    publicBrand: brandSchema,
    audience: z.literal("public"),
    key: z.string().startsWith("artifacts/"),
    filename: z.string().min(1),
    contentType: z.string().min(1),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("legacy-site"),
    publicBrand: brandSchema,
    audience: z.literal("public"),
    pointerKey: z.string().startsWith("sites/"),
  }),
]);
export type ArtifactDeliveryRecord = z.infer<
  typeof artifactDeliveryRecordSchema
>;

export function artifactDeliveryKey(
  brand: "vm0" | "okou" | null,
  kind: "file" | "html",
  alias: string,
): string {
  // One file hostname spans both brands, so file aliases have one namespace.
  if (kind === "file")
    return `artifact-delivery/files/${encodeURIComponent(alias)}.json`;
  if (!brand)
    throw new Error("A hosted artifact registry key requires a brand");
  return `artifact-delivery/${brand}/html/${encodeURIComponent(alias)}.json`;
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
export function artifactDeliveryRegistrationKey(brand: "vm0" | "okou"): string {
  return `artifact-delivery/${brand}/registration.json`;
}
