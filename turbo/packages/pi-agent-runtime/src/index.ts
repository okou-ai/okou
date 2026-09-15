import { isPiAgentModelSupported as isPiAgentModelSupportedImpl } from "./model";
import type { PiAgentModelConfig } from "./types";

/** Whether Pi's native provider catalog knows this model. */
export const isPiAgentModelSupported: (config: PiAgentModelConfig) => boolean =
  isPiAgentModelSupportedImpl;

export {
  assertPiNativeCredential,
  materializePiAgentModelConfig,
  materializePiExecutionRoute,
  resolvePiAgentCredential,
} from "./credential";
export { normalizePiExecutionRoute } from "./execution-route";
export type { PiExecutionRoute } from "./execution-route";
export { PI_AGENT_THINKING_LEVELS } from "./types";
export type {
  PiAgentCredentialHeaderTemplate,
  PiAgentCredentialReference,
  PiAgentCredentialTarget,
  PiAgentDialect,
  PiAgentModelConfig,
  PiAgentRequestHeaders,
  PiAgentServiceTier,
  PiAgentThinkingLevel,
  PiAgentTransport,
} from "./types";
