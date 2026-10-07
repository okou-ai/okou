import type { PiModelConfig } from "@okouai/api-contracts/contracts/runners";
import {
  normalizePiExecutionRoute,
  type PiExecutionRoute,
} from "./execution-route";

import type { PiAgentCredentialReference, PiAgentModelConfig } from "./types";

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

/**
 * Materialize one validated route at an execution edge. Callers control where
 * values come from: maintenance workers supply decrypted secrets, while Sandbox launch
 * supplies only its existing opaque environment placeholders.
 */
export async function materializePiAgentModelConfig(args: {
  readonly config: PiModelConfig;
  readonly resolveCredential: (
    binding: PiAgentCredentialReference,
  ) => string | Promise<string>;
}): Promise<PiAgentModelConfig> {
  return await materializePiExecutionRoute({
    route: normalizePiExecutionRoute(args.config),
    resolveCredential: args.resolveCredential,
  });
}

/** Materialize captured internal intent without reselecting its provider. */
export async function materializePiExecutionRoute(args: {
  readonly route: PiExecutionRoute;
  readonly resolveCredential: (
    binding: PiAgentCredentialReference,
  ) => string | Promise<string>;
}): Promise<PiAgentModelConfig> {
  const config = structuredClone(args.route);

  if (config.dialect === "openai-responses") {
    const { credentialBindings, ...route } = config;
    const binding = credentialBindings[0];
    const credential = await resolvedCredentialValue({
      binding,
      resolveCredential: args.resolveCredential,
    });
    return {
      ...route,
      apiKey: credential,
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
