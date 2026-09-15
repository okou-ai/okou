import { PI_NATIVE_CREDENTIAL_PLACEHOLDER } from "@okouai/api-contracts/contracts/pi-native";
import type { PiModelConfig } from "@okouai/api-contracts/contracts/runners";
import {
  normalizePiExecutionRoute,
  type PiExecutionRoute,
} from "./execution-route";

import type {
  PiAgentCredentialHeaderTemplate,
  PiAgentCredentialReference,
  PiAgentCredentialTarget,
  PiAgentModelConfig,
  PiAgentRequestHeaders,
} from "./types";

const CREDENTIAL_PLACEHOLDER = "{{secret}}";
const UNUSED_OPENAI_API_KEY = "unused";
const HEADER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

function resolvedCredentialHeaderValue(args: {
  readonly credential: string;
  readonly header: PiAgentCredentialHeaderTemplate;
  readonly target: PiAgentCredentialTarget;
}): string {
  const staticTemplate = args.header.valueTemplate.replace(
    CREDENTIAL_PLACEHOLDER,
    "",
  );
  if (
    !HEADER_NAME_PATTERN.test(args.header.name) ||
    args.header.valueTemplate.includes("\r") ||
    args.header.valueTemplate.includes("\n") ||
    args.header.valueTemplate.split(CREDENTIAL_PLACEHOLDER).length !== 2 ||
    staticTemplate.includes("{{") ||
    staticTemplate.includes("}}")
  ) {
    throw new Error("Pi credential header policy is invalid");
  }
  return args.target === "sandbox-firewall"
    ? args.credential
    : args.header.valueTemplate.replace(
        CREDENTIAL_PLACEHOLDER,
        args.credential,
      );
}

/**
 * Resolve one credential at the execution edge. Custom gateway secrets travel
 * only in their configured header; the OpenAI SDK receives a non-secret dummy
 * key so it cannot copy the gateway credential into Authorization implicitly.
 */
export function resolvePiAgentCredential(args: {
  readonly credential: string;
  readonly header?: PiAgentCredentialHeaderTemplate;
  readonly target: PiAgentCredentialTarget;
}): {
  readonly apiKey: string;
  readonly requestHeaders?: PiAgentRequestHeaders;
} {
  if (!args.credential.trim()) {
    throw new Error("Pi model credential is unavailable");
  }
  if (!args.header) {
    return { apiKey: args.credential };
  }
  const requestHeaders: PiAgentRequestHeaders = {
    ...(args.header.name.toLowerCase() === "authorization"
      ? {}
      : { authorization: null }),
    [args.header.name]: resolvedCredentialHeaderValue({
      credential: args.credential,
      header: args.header,
      target: args.target,
    }),
  };
  return { apiKey: UNUSED_OPENAI_API_KEY, requestHeaders };
}

async function resolvedCredentialValue(args: {
  readonly binding: PiAgentCredentialReference;
  readonly resolveCredential: (
    binding: PiAgentCredentialReference,
  ) => string | Promise<string>;
}): Promise<string> {
  const value = await args.resolveCredential(args.binding);
  if (!value.trim()) {
    throw new Error(`Pi ${args.binding.kind} credential is unavailable`);
  }
  return value;
}

/** Official Claude subscription credentials are never valid Pi API credentials. */
export function assertPiNativeCredential(value: string): void {
  if (
    !value.trim() ||
    /sk-ant-(?:oat|ort)/iu.test(value) ||
    /[\r\n]/u.test(value)
  ) {
    throw new Error(
      "Pi native credential is unavailable or is a Claude subscription token",
    );
  }
}

async function materializeNative(args: {
  readonly config: Extract<
    PiExecutionRoute,
    { readonly dialect: "anthropic-messages" | "bedrock-converse-stream" }
  >;
  readonly target: PiAgentCredentialTarget;
  readonly resolveCredential: (
    binding: PiAgentCredentialReference,
  ) => string | Promise<string>;
}): Promise<PiAgentModelConfig> {
  const config = args.config;
  const values = new Map<PiAgentCredentialReference["kind"], string>();
  for (const binding of config.credentialBindings) {
    const value = await resolvedCredentialValue({
      binding,
      resolveCredential: args.resolveCredential,
    });
    assertPiNativeCredential(value);
    if (
      args.target === "sandbox-firewall" &&
      value !== PI_NATIVE_CREDENTIAL_PLACEHOLDER
    ) {
      throw new Error(
        "Pi native sandbox credentials must be opaque firewall markers",
      );
    }
    values.set(binding.kind, value);
  }
  const required = (kind: PiAgentCredentialReference["kind"]): string => {
    const value = values.get(kind);
    if (!value) throw new Error(`Pi native ${kind} credential is unavailable`);
    return value;
  };
  const route = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    catalogModel: config.catalogModel,
    thinkingLevel: config.thinkingLevel,
  };
  if (config.dialect === "anthropic-messages") {
    const binding = config.credentialBindings[0];
    if (!binding) throw new Error("Pi native API-key binding is unavailable");
    assertPiNativeCredential(binding.credentialHeader.valueTemplate);
    const credential = resolvePiAgentCredential({
      credential: required("api-key"),
      header: binding.credentialHeader,
      target: args.target,
    });
    return {
      ...route,
      provider: config.provider,
      dialect: config.dialect,
      transport: config.transport,
      ...credential,
      requestHeaders: {
        "x-api-key": null,
        authorization: null,
        ...credential.requestHeaders,
      },
    };
  }
  return {
    ...route,
    provider: config.provider,
    dialect: config.dialect,
    transport: config.transport,
    // Explicit dummy prevents Pi's model registry from resolving ambient auth.
    apiKey: "unused",
    region: config.region,
    bedrockAuth:
      config.authMode === "bearer"
        ? { kind: "bearer", token: required("aws-bearer-token") }
        : {
            kind: "sigv4",
            accessKeyId: required("aws-access-key-id"),
            secretAccessKey: required("aws-secret-access-key"),
            ...(values.has("aws-session-token")
              ? { sessionToken: required("aws-session-token") }
              : {}),
          },
  };
}

/**
 * Materialize one validated route at an execution edge. Callers control where
 * values come from: API-first supplies decrypted secrets, while Sandbox launch
 * supplies only its existing opaque environment placeholders.
 */
export async function materializePiAgentModelConfig(args: {
  readonly config: PiModelConfig;
  readonly target: PiAgentCredentialTarget;
  readonly resolveCredential: (
    binding: PiAgentCredentialReference,
  ) => string | Promise<string>;
}): Promise<PiAgentModelConfig> {
  return await materializePiExecutionRoute({
    route: normalizePiExecutionRoute(args.config),
    target: args.target,
    resolveCredential: args.resolveCredential,
  });
}

/** Materialize captured internal intent without reselecting its provider. */
export async function materializePiExecutionRoute(args: {
  readonly route: PiExecutionRoute;
  readonly target: PiAgentCredentialTarget;
  readonly resolveCredential: (
    binding: PiAgentCredentialReference,
  ) => string | Promise<string>;
}): Promise<PiAgentModelConfig> {
  const config = structuredClone(args.route);
  if (
    config.dialect === "anthropic-messages" ||
    config.dialect === "bedrock-converse-stream"
  ) {
    return await materializeNative({ ...args, config });
  }

  if (config.dialect === "openai-responses") {
    const { credentialBindings, ...route } = config;
    const binding = credentialBindings[0];
    const credential = await resolvedCredentialValue({
      binding,
      resolveCredential: args.resolveCredential,
    });
    return {
      ...route,
      ...resolvePiAgentCredential({
        credential,
        header: binding.credentialHeader,
        target: args.target,
      }),
    };
  }

  const { credentialBindings, ...route } = config;
  const [accessTokenBinding, accountIdBinding] = credentialBindings;
  // Subscription credentials are one ordered bundle. The access token may be
  // refreshed at this boundary, so the matching account ID must only be read
  // after that refresh has settled.
  const apiKey = await resolvedCredentialValue({
    binding: accessTokenBinding,
    resolveCredential: args.resolveCredential,
  });
  const accountId = await resolvedCredentialValue({
    binding: accountIdBinding,
    resolveCredential: args.resolveCredential,
  });
  return {
    ...route,
    apiKey,
    accountId,
  };
}
