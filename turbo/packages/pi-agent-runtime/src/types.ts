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

export type PiAgentServiceTier = "priority" | "fast";

export type PiAgentDialect =
  | "openai-responses"
  | "openai-completions"
  | "openai-codex-responses";

export type PiAgentTransport = "sse";

export interface PiAgentCredentialReference {
  readonly kind: "api-key" | "access-token" | "account-id";
  readonly environment: string;
  readonly secretName: string;
}

/** Model endpoint and credential resolved at a Pi execution edge. */
interface PiAgentModelCommon {
  /** Provider identity used for trusted catalog metadata. */
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Provider model identifier sent with requests. */
  readonly model: string;
  /** Catalog entry when the request model differs from the catalog identity. */
  readonly catalogModel?: string;
  /** Omitted by legacy launch payloads, which retain Pi's medium default. */
  readonly thinkingLevel?: PiAgentThinkingLevel;
  /**
   * Provider sticky-routing key for Chat Completions. Sandbox launches use the
   * owning chat thread so every Run of a thread keeps the same upstream cache;
   * omitted keys fall back to the Pi session ID.
   */
  readonly sessionAffinityKey?: string;
}

/** Secret-bearing configuration exists only at the owning execution edge. */
export type PiAgentModelConfig = PiAgentModelCommon &
  (
    | {
        readonly dialect: "openai-responses";
        readonly transport: "sse";
        readonly serviceTier?: "priority";
        readonly accountId?: never;
      }
    | {
        readonly dialect: "openai-completions";
        readonly provider: "openrouter";
        readonly transport: "sse";
        readonly serviceTier?: never;
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
        | "serviceTier"
        | "transport"
        | "catalogModel"
        | "sessionAffinityKey"
      >
    : never;
