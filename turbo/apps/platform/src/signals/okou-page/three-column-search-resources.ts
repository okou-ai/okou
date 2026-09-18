import { createAttachmentPreviewSignals } from "../attachment-resource-url.ts";
import { computed, type Computed } from "ccstate";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";

import { accept } from "../../lib/accept.ts";
import { agents$ } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import {
  createImageLoadSignals,
  type ImageLoadSignals,
} from "../image-load.ts";
import { allVisibleWorkflows$ } from "../workflows-page/workflows-signals.ts";
import { chatListQuery$ } from "./sidebar-state.ts";

const MAX_RESOURCE_SEARCH_RESULTS = 25;
const SPOTLIGHT_ARTIFACT_THUMBNAIL_WIDTH_PX = 64;

interface ThreeColumnAgentSearchResult {
  readonly query: string;
  readonly agents: readonly AgentResponse[];
}

export const threeColumnAgentSearchResults$ = computed(
  async (get): Promise<ThreeColumnAgentSearchResult> => {
    const query = get(chatListQuery$).trim().toLowerCase();
    if (!query) {
      return { query, agents: [] };
    }
    const agents = await get(agents$);
    return {
      query,
      agents: agents
        .filter((agent) => {
          return agent.displayName?.toLowerCase().includes(query) ?? false;
        })
        .slice(0, MAX_RESOURCE_SEARCH_RESULTS),
    };
  },
);

interface ThreeColumnWorkflowSearchResult {
  readonly query: string;
  readonly workflows: readonly WorkflowSummary[];
}

export type ThreeColumnArtifactSearchItem = ArtifactSummary & {
  readonly thumbnailLoad: ImageLoadSignals;
  readonly thumbnailUrl$: Computed<Promise<string | null>>;
};

interface ThreeColumnArtifactSearchResult {
  readonly query: string;
  readonly artifacts: readonly ThreeColumnArtifactSearchItem[];
}

function workflowMatchesQuery(
  workflow: WorkflowSummary,
  query: string,
): boolean {
  return [workflow.displayName, workflow.name, workflow.description].some(
    (value) => {
      return value?.toLowerCase().includes(query) ?? false;
    },
  );
}

export const threeColumnWorkflowSearchResults$ = computed(
  async (get): Promise<ThreeColumnWorkflowSearchResult> => {
    const query = get(chatListQuery$).trim().toLowerCase();
    if (!query) {
      return { query, workflows: [] };
    }
    const workflows = await get(allVisibleWorkflows$);
    return {
      query,
      workflows: workflows
        .filter((workflow) => {
          return workflowMatchesQuery(workflow, query);
        })
        .slice(0, MAX_RESOURCE_SEARCH_RESULTS),
    };
  },
);

export const threeColumnArtifactSearchResults$ = computed(
  async (get): Promise<ThreeColumnArtifactSearchResult> => {
    const query = get(chatListQuery$).trim().toLowerCase();
    if (!query) {
      return { query, artifacts: [] };
    }
    const client = get(apiClient$)(artifactCatalogContract);
    const result = await accept(
      client.list({
        query: { keyword: query, limit: MAX_RESOURCE_SEARCH_RESULTS },
      }),
      [200],
    );
    return {
      query,
      artifacts: result.body.artifacts.map((artifact) => {
        return {
          ...artifact,
          thumbnailLoad: createImageLoadSignals(),
          thumbnailUrl$: computed(async (get) => {
            return artifact.thumbnail
              ? await get(
                  createAttachmentPreviewSignals(artifact.thumbnail.url, {
                    thumbnailSize: {
                      width: SPOTLIGHT_ARTIFACT_THUMBNAIL_WIDTH_PX,
                    },
                  }).thumbnailUrl$,
                )
              : null;
          }),
        };
      }),
    };
  },
);
