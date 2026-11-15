import { literal, number, object, string, url, type infer as Infer } from "zod";
import { androidVersionSchema } from "../validators/android-version";
import { apiErrorSchema } from "./api-error";
import { initContract } from "./trpc-contract";

export const androidReleaseSchema = object({
  version: androidVersionSchema,
  minimumSdk: number().int().min(24).max(10_000),
  size: number().int().positive().max(2_147_483_647),
  sha256: string().regex(/^[a-f0-9]{64}$/u),
  url: url().max(512),
  notes: string().max(8_000),
});
export const androidReleaseManifestSchema = object({
  schemaVersion: literal(1),
  release: androidReleaseSchema,
});
export const androidUpdatesResponseSchema = object({
  minimumSupportedVersion: androidVersionSchema.nullable(),
  release: androidReleaseSchema,
});
export const androidUpdatesContract = initContract().router({
  get: {
    method: "GET",
    path: "/api/android/updates",
    responses: { 200: androidUpdatesResponseSchema, 503: apiErrorSchema },
    summary: "Read the public Android release and compatibility policy",
  },
});
export type AndroidRelease = Infer<typeof androidReleaseSchema>;
