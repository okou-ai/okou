import { importFeatureGuideSchema } from "@okouai/api-contracts/contracts/feature-guides";
import { command } from "ccstate";
import googleWorkspaceGuide from "../feature-guides/google-workspace-2026-10-28.json";
import { optionalEnv } from "../lib/env";
import {
  importFeatureGuide$,
  publishFeatureGuide$,
} from "../signals/services/feature-guides.service";

export const seedPreviewFeatureGuide$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (optionalEnv("ENV") !== "preview") {
      return;
    }
    const result = await set(
      importFeatureGuide$,
      importFeatureGuideSchema.parse(googleWorkspaceGuide),
      "preview-seed",
      signal,
    );
    await set(
      publishFeatureGuide$,
      result.editionId,
      result.revisionId,
      "preview-seed",
      signal,
    );
  },
);
