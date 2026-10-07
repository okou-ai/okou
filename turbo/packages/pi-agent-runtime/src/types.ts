export const PI_AGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiAgentThinkingLevel = (typeof PI_AGENT_THINKING_LEVELS)[number];

export type PiAgentServiceTier = "priority" | "fast" | "ultrafast";

export type PiAgentDialect = "openai-responses" | "openai-codex-responses";

export type PiAgentTransport = "sse";

export type PiAgentCredentialTarget = "direct" | "sandbox-firewall";

export type PiAgentRequestHeaders = Readonly<Record<string, string | null>>;

export interface PiAgentCredentialHeaderTemplate {
  readonly name: string;
  readonly valueTemplate: string;
}

export interface PiAgentCredentialReference {
  readonly kind: "api-key" | "access-token" | "account-id";
  readonly environment: string;
  readonly secretName: string;
  readonly credentialHeader?: PiAgentCredentialHeaderTemplate;
}

/** Model endpoint and credential resolved at a Pi execution edge. */
interface PiAgentModelCommon {
  /** Native provider identity used for trusted catalog metadata. */
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Provider model identifier sent with requests. */
  readonly model: string;
  /** Native catalog entry when the request model uses a gateway alias. */
  readonly catalogModel?: string;
  /** Execution-edge headers that override provider defaults case-insensitively. */
  readonly requestHeaders?: PiAgentRequestHeaders;
  /** Omitted by legacy launch payloads, which retain Pi's medium default. */
  readonly thinkingLevel?: PiAgentThinkingLevel;
}

/** Secret-bearing configuration exists only at the owning execution edge. */
export type PiAgentModelConfig = PiAgentModelCommon &
  (
    | {
        readonly dialect: "openai-responses";
        readonly transport: "sse";
        readonly serviceTier?: "priority" | "ultrafast";
        readonly accountId?: never;
      }
    | {
        readonly dialect: "openai-codex-responses";
        readonly provider: "openai-codex";
        readonly catalogModel?: never;
        readonly transport: "sse";
        readonly accountId: string;
        readonly serviceTier?: "fast";
      }
  );

/** Distribute before picking so every helper retains dialect requirements. */
export type PiAgentStreamConfig<T = PiAgentModelConfig> =
  T extends PiAgentModelConfig
    ? Pick<
        T,
        | "accountId"
        | "dialect"
        | "requestHeaders"
        | "serviceTier"
        | "transport"
        | "catalogModel"
      >
    : never;
