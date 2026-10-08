import {
  fallbackCategoryLabel,
  type ConnectorCategoryLabels,
} from "../../../../signals/okou-page/settings/connector-categories.ts";

import { i18n } from "../../../../i18n/index.ts";

// Category labels come from the catalog API in English. The UI shows the
// localized copy instead, keyed by the stable category id.
type ConnectorCategoryTranslation = {
  readonly label: string;
  readonly menuLabel: string;
};

// The switch is split only to stay inside the per-function line limit; every
// arm has to name its key statically so the i18n extractor can find it.
function aiCategoryTranslation(
  id: string,
): ConnectorCategoryTranslation | null {
  switch (id) {
    case "ai": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.ai.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.ai.menu;
        }),
      };
    }
    case "ai-agent-apps": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.aiAgentApps.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.aiAgentApps.menu;
        }),
      };
    }
    case "ai-general-models": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.aiGeneralModels.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.aiGeneralModels.menu;
        }),
      };
    }
    case "ai-image-video": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.aiImageVideo.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.aiImageVideo.menu;
        }),
      };
    }
    case "ai-memory-tracing-eval": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.aiMemoryTracingEval.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.aiMemoryTracingEval.menu;
        }),
      };
    }
    case "ai-voice-audio": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.aiVoiceAudio.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.aiVoiceAudio.menu;
        }),
      };
    }
    default: {
      return null;
    }
  }
}

function businessCategoryTranslation(
  id: string,
): ConnectorCategoryTranslation | null {
  switch (id) {
    case "communication-collaboration": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.communicationCollaboration
            .label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.communicationCollaboration
            .menu;
        }),
      };
    }
    case "data-automation-infrastructure": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.dataAutomationInfrastructure
            .label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.dataAutomationInfrastructure
            .menu;
        }),
      };
    }
    case "docs-files-knowledge": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.docsFilesKnowledge.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.docsFilesKnowledge.menu;
        }),
      };
    }
    case "engineering-team-execution": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.engineeringTeamExecution.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.engineeringTeamExecution.menu;
        }),
      };
    }
    case "marketing-content-growth": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.marketingContentGrowth.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.marketingContentGrowth.menu;
        }),
      };
    }
    case "meetings-scheduling": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.meetingsScheduling.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.meetingsScheduling.menu;
        }),
      };
    }
    case "sales-crm-business-operations": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.salesCrmBusinessOperations
            .label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.salesCrmBusinessOperations
            .menu;
        }),
      };
    }
    default: {
      return null;
    }
  }
}

function connectorCategoryTranslation(
  id: string,
): ConnectorCategoryTranslation | null {
  return aiCategoryTranslation(id) ?? businessCategoryTranslation(id);
}

// Catalog entries carry only a category id. A known id uses its localized copy
// and any other id a label derived from it; categories are ordered by label
// and never grouped.
export function connectorCategoryLabels(
  categoryIds: Iterable<string>,
): ConnectorCategoryLabels {
  const categories = [...new Set(categoryIds)]
    .map((id) => {
      const translation = connectorCategoryTranslation(id);
      const fallback = fallbackCategoryLabel(id);
      return {
        id,
        label: translation?.label ?? fallback,
        menuLabel: translation?.menuLabel ?? fallback,
        groupId: null,
      };
    })
    .sort((left, right) => {
      return left.label.localeCompare(right.label);
    });
  return { categories, groups: [] };
}
