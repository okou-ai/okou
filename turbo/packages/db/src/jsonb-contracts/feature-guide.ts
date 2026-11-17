import {
  featureGuideAudienceSchema,
  featureGuideContentSchema,
} from "@okouai/api-contracts/contracts/feature-guides";
import { type infer as zInfer } from "zod";

// Keep targeting in the immutable revision. Earlier strict readers reject it
// rather than silently delivering a targeted revision to everyone.
export const featureGuideRevisionContentSchema =
  featureGuideContentSchema.extend({
    audience: featureGuideAudienceSchema.optional(),
  });

export type FeatureGuideRevisionContent = zInfer<
  typeof featureGuideRevisionContentSchema
>;
