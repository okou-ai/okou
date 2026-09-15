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
  | "openai-codex-responses"
  | "anthropic-messages"
  | "bedrock-converse-stream";

export type PiAgentTransport = "sse" | "aws-event-stream";

export type PiAgentCredentialTarget = "direct" | "sandbox-firewall";

export type PiAgentRequestHeaders = Readonly<Record<string, string | null>>;

export interface PiAgentCredentialHeaderTemplate {
  readonly name: string;
  readonly valueTemplate: string;
}

export interface PiAgentCredentialReference {
  readonly kind:
    | "api-key"
    | "access-token"
    | "account-id"
    | "aws-bearer-token"
    | "aws-access-key-id"
    | "aws-secret-access-key"
    | "aws-session-token";
  readonly environment: string;
  readonly secretName: string;
  readonly credentialHeader?: PiAgentCredentialHeaderTemplate;
}

export type PiAgentBedrockAuth =
  | { readonly kind: "bearer"; readonly token: string }
  | {
      readonly kind: "sigv4";
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken?: string;
    };

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
        readonly serviceTier?: "priority";
        readonly accountId?: never;
        readonly region?: never;
        readonly bedrockAuth?: never;
      }
    | {
        readonly dialect: "openai-codex-responses";
        readonly provider: "openai-codex";
        readonly catalogModel?: never;
        readonly transport: "sse";
        readonly accountId: string;
        readonly serviceTier?: "fast";
        readonly region?: never;
        readonly bedrockAuth?: never;
      }
    | {
        readonly dialect: "anthropic-messages";
        readonly provider: "anthropic";
        readonly transport: "sse";
        readonly catalogModel: string;
        readonly requestHeaders: PiAgentRequestHeaders;
        readonly serviceTier?: never;
        readonly accountId?: never;
        readonly region?: never;
        readonly bedrockAuth?: never;
      }
    | {
        readonly dialect: "bedrock-converse-stream";
        readonly provider: "amazon-bedrock";
        readonly transport: "aws-event-stream";
        readonly catalogModel: string;
        readonly region: string;
        readonly bedrockAuth: PiAgentBedrockAuth;
        readonly serviceTier?: never;
        readonly accountId?: never;
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
        | "region"
        | "bedrockAuth"
      >
    : never;
