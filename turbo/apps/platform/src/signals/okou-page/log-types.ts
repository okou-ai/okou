// API response types (matching app API contracts)
import type {
  LogStatus,
  TriggerSource,
} from "@okouai/api-contracts/contracts/logs";
import type {
  AgentEventsResponse as ApiAgentEventsResponse,
  RunEvent,
} from "@okouai/api-contracts/contracts/runs";
import { i18n } from "../../i18n/index.ts";

// Re-export from core contract to stay in sync with the API schema
export type { LogStatus, TriggerSource };

/** Build a display label for a trigger source. */
export function getTriggerSourceLabel(
  source: TriggerSource,
  appendSystemPrompt?: string | null,
): string {
  switch (source) {
    case "web": {
      return i18n.t(($) => {
        return $.activity.sources.web;
      });
    }
    case "slack": {
      return i18n.t(($) => {
        return $.activity.sources.slack;
      });
    }
    case "teams": {
      return i18n.t(($) => {
        return $.activity.sources.teams;
      });
    }
    case "feishu": {
      // Historical Lark runs retain the shared Feishu source. Preserve their
      // existing label only when the captured integration prompt identifies Lark.
      const isLark =
        appendSystemPrompt
          ?.split("# Current Integration\n")[1]
          ?.startsWith("You are currently running inside: Lark\n") ?? false;
      return i18n.t(($) => {
        return $.activity.sources[isLark ? "lark" : "feishu"];
      });
    }
    case "lark": {
      return i18n.t(($) => {
        return $.activity.sources.lark;
      });
    }
    case "email": {
      return i18n.t(($) => {
        return $.activity.sources.email;
      });
    }
    case "telegram": {
      return i18n.t(($) => {
        return $.activity.sources.telegram;
      });
    }
    case "agentphone": {
      return i18n.t(($) => {
        return $.activity.sources.agentphone;
      });
    }
    case "github": {
      return i18n.t(($) => {
        return $.activity.sources.github;
      });
    }
    case "test": {
      return i18n.t(($) => {
        return $.activity.sources.test;
      });
    }
    case "agent": {
      return i18n.t(($) => {
        return $.activity.sources.agent;
      });
    }
    case "webhook": {
      return i18n.t(($) => {
        return $.activity.sources.webhook;
      });
    }
    case "automation-schedule": {
      return i18n.t(($) => {
        return $.activity.sources.automationSchedule;
      });
    }
    case "automation-event": {
      return i18n.t(($) => {
        return $.activity.sources.automationEvent;
      });
    }
    case "goal": {
      return i18n.t(($) => {
        return $.activity.sources.goal;
      });
    }
  }
}

// Detail response - full log information
interface Artifact {
  name: string | null;
  version: string | null;
}

export interface LogDetail {
  id: string;
  sessionId: string | null;
  agentId: string | null;
  displayName: string | null;
  framework: string | null;
  modelProvider: string | null;
  selectedModel: string | null;
  modelRuntimeProvider?: string | null;
  modelRuntimeModel?: string | null;
  triggerSource: TriggerSource | null;
  status: LogStatus;
  prompt: string;
  appendSystemPrompt: string | null;
  error: string | null;
  createdAt: string; // ISO timestamp
  startedAt: string | null;
  completedAt: string | null;
  artifact: Artifact;
}

export type AgentEvent = RunEvent;
export type AgentEventsResponse = ApiAgentEventsResponse;
