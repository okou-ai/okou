import { isPiAgentModelSupported as isPiAgentModelSupportedImpl } from "./model-catalog";
import type { PiAgentModelConfig } from "./types";

/** Whether Pi's provider catalog knows this model. */
export const isPiAgentModelSupported: (config: PiAgentModelConfig) => boolean =
  isPiAgentModelSupportedImpl;

export {
  materializePiAgentModelConfig,
  materializePiExecutionRoute,
} from "./credential";
export { normalizePiExecutionRoute } from "./execution-route";
export type { PiExecutionRoute } from "./execution-route";
export { PI_AGENT_THINKING_LEVELS } from "./types";
export type {
  PiAgentCredentialReference,
  PiAgentDialect,
  PiAgentModelConfig,
  PiAgentServiceTier,
  PiAgentThinkingLevel,
  PiAgentTransport,
} from "./types";
