import type { ImportFeatureGuide } from "@okouai/api-contracts/contracts/feature-guides";
import { command } from "ccstate";
import { optionalEnv } from "../lib/env";
import {
  importFeatureGuide$,
  publishFeatureGuide$,
} from "../signals/services/feature-guides.service";

function previewGuide(): ImportFeatureGuide {
  return {
    editionId: "preview-feature-guide",
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    content: {
      schemaVersion: 1,
      title: "More ways to put Okou to work",
      description:
        "A preview of the new feature guide. These examples demonstrate the interface, not a production release announcement.",
      items: [
        {
          featureId: "weekly-report",
          title: "Prepare a weekly update",
          description: "Turn your notes into a clear team update.",
          prompt:
            "Help me turn my team notes into a weekly update with progress, open questions, and next steps.",
        },
        {
          featureId: "handoff",
          title: "Make the handoff easier",
          description: "Prepare a result that a teammate can use.",
          prompt:
            "Help me prepare a concise handoff summary for a teammate. Show me the draft before sharing anything.",
        },
        {
          featureId: "repeat-work",
          title: "Repeat a useful process",
          description: "Explore a short click-through example.",
          media: {
            type: "walkthrough",
            steps: [
              {
                title: "Describe the work",
                description:
                  "Start with the outcome you want and the information it needs.",
              },
              {
                title: "Review the approach",
                description:
                  "Check the steps and output before putting a process on a schedule.",
              },
            ],
          },
        },
      ],
    },
  };
}

export const seedPreviewFeatureGuide$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (optionalEnv("ENV") !== "preview") {
      return;
    }
    const result = await set(
      importFeatureGuide$,
      previewGuide(),
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
