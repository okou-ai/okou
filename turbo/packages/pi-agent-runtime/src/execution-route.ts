import {
  piModelConfigSchema,
  type PiModelConfig,
  type PiModelConfigLegacy,
} from "@okouai/api-contracts/contracts/runners";
import type { PiModelConfigV4 } from "@okouai/api-contracts/contracts/pi-native";

import type { PiAgentCredentialReference } from "./types";

type NativeRoute<T = PiModelConfigV4> = T extends PiModelConfigV4
  ? Omit<T, "schemaVersion"> & { readonly serviceTier?: never }
  : never;

type ResponsesRoute = Omit<
  PiModelConfigLegacy,
  "apiKeyEnv" | "credentialSecretName" | "credentialHeader"
>;

type CredentialBinding<K extends PiAgentCredentialReference["kind"]> =
  PiAgentCredentialReference & { readonly kind: K };

/** In-process captured intent. Never persist this in place of the original wire. */
export type PiExecutionRoute =
  | (ResponsesRoute & {
      readonly dialect: "openai-responses";
      readonly transport: "sse";
      readonly credentialBindings: readonly [CredentialBinding<"api-key">];
    })
  | (Pick<ResponsesRoute, "baseUrl" | "model" | "thinkingLevel"> & {
      readonly provider: "openai-codex";
      readonly dialect: "openai-codex-responses";
      readonly transport: "sse";
      readonly serviceTier?: "fast";
      readonly credentialBindings: readonly [
        CredentialBinding<"access-token">,
        CredentialBinding<"account-id">,
      ];
    })
  | NativeRoute;

/**
 * Normalize the supported readers, taking owned copies of nested policy before
 * any asynchronous credential work. Validation remains at the wire boundary;
 * the original generation is still authoritative for claims and observation.
 */
export function normalizePiExecutionRoute(
  wire: PiModelConfig,
): PiExecutionRoute {
  const config = piModelConfigSchema.parse(wire);
  if (!("schemaVersion" in config)) {
    const { apiKeyEnv, credentialSecretName, credentialHeader, ...route } =
      config;
    return {
      ...route,
      dialect: "openai-responses",
      transport: "sse",
      credentialBindings: [
        {
          kind: "api-key",
          environment: apiKeyEnv,
          secretName: credentialSecretName,
          ...(credentialHeader === undefined ? {} : { credentialHeader }),
        },
      ],
    };
  }
  if (config.schemaVersion === 4) {
    const { schemaVersion: _schemaVersion, ...route } = config;
    return route;
  }
  const {
    schemaVersion: _schemaVersion,
    credentialBindings,
    serviceTier,
    ...route
  } = config;
  const required = <K extends "api-key" | "access-token" | "account-id">(
    kind: K,
  ): CredentialBinding<K> => {
    const binding = credentialBindings.find((candidate) => {
      return candidate.kind === kind;
    });
    if (!binding)
      throw new Error(`Pi model config is missing its ${kind} binding`);
    return { ...binding, kind };
  };
  if (route.dialect === "openai-responses") {
    if (serviceTier !== undefined && serviceTier !== "priority") {
      throw new Error("Pi public Responses requires a public service tier");
    }
    // V2's schema refinement supplies this invariant; keep it explicit here
    // because its TypeScript type predates the dialect-discriminated V3 reader.
    if (route.provider === "openai-codex") {
      throw new Error("Pi public Responses cannot use the Codex catalog");
    }
    return {
      ...route,
      provider: route.provider,
      dialect: "openai-responses",
      ...(serviceTier === undefined ? {} : { serviceTier }),
      credentialBindings: [required("api-key")],
    };
  }
  if (
    route.provider !== "openai-codex" ||
    (serviceTier !== undefined && serviceTier !== "fast")
  ) {
    throw new Error("Pi Codex Responses requires its catalog and service tier");
  }
  const { catalogModel: _catalogModel, ...codex } = route;
  return {
    ...codex,
    provider: "openai-codex",
    dialect: "openai-codex-responses",
    ...(serviceTier === undefined ? {} : { serviceTier }),
    credentialBindings: [required("access-token"), required("account-id")],
  };
}
