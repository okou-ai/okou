import { createHash } from "node:crypto";

import { z } from "zod";

import {
  CONNECTOR_GENERIC_AUTH_CAPABILITY_VERSIONS,
  getConnectorAuthProviderRegistrationCapabilities,
  type ConnectorAuthProviderMethodContract,
  type ConnectorAuthProviderRegistrationCapability,
} from "../auth-providers/connector-auth";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "../connector-identity";

import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogAuthMethod,
} from "./artifacts/artifacts";
import {
  connectorCatalogCompatibilityReasonSchema,
  type ConnectorCatalogCompatibilityReason,
} from "./contracts";

const COMPATIBILITY_REASON_ORDER = [
  "unsupported-protocol",
  "missing-grant-provider",
  "missing-access-provider",
  "missing-revoke-provider",
  "provider-contract-mismatch",
  "missing-platform-configuration",
] as const satisfies readonly ConnectorCatalogCompatibilityReason[];

export const connectorCatalogCompatibilityEvaluationSchema = z
  .object({
    filteredAuthMethods: z.array(
      z
        .object({
          connectorSlug: connectorSlugSchema,
          authMethodId: connectorAuthMethodIdSchema,
          reasons: z.array(connectorCatalogCompatibilityReasonSchema).min(1),
        })
        .strict(),
    ),
  })
  .strict();

const EXECUTABLE_CAPABILITY_EVALUATOR_VERSION = 3;

export interface ExecutableCapabilityState {
  readonly digest: string;
  readonly configuredNames: ReadonlySet<string>;
  readonly registrations: readonly ConnectorAuthProviderRegistrationCapability[];
}

interface ExecutableCapabilityConfiguration {
  readonly name: string;
  readonly present: boolean;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function registrationKey(connectorSlug: string, authMethodId: string): string {
  return `${connectorSlug}\0${authMethodId}`;
}

function executableCapabilityDigest(args: {
  readonly registrations: readonly ConnectorAuthProviderRegistrationCapability[];
  readonly configuration: readonly ExecutableCapabilityConfiguration[];
}): string {
  const preimage = JSON.stringify({
    evaluatorVersion: EXECUTABLE_CAPABILITY_EVALUATOR_VERSION,
    generic: CONNECTOR_GENERIC_AUTH_CAPABILITY_VERSIONS,
    registrations: args.registrations,
    configuration: args.configuration,
  });
  return `sha256:${createHash("sha256").update(preimage).digest("hex")}`;
}

export function connectorCatalogExecutableCapabilityState(args: {
  readonly isConfigured: (name: string) => boolean;
}): ExecutableCapabilityState {
  const registrations = getConnectorAuthProviderRegistrationCapabilities();
  const configurationNames = [
    ...new Set(
      registrations.flatMap((registration) => {
        return registration.requiredConfigurationNames;
      }),
    ),
  ].sort(compareStrings);
  const configuration = configurationNames.map((name) => {
    return { name, present: args.isConfigured(name) };
  });
  const configuredNames = new Set(
    configuration.flatMap(({ name, present }) => {
      return present ? [name] : [];
    }),
  );
  return {
    digest: executableCapabilityDigest({ registrations, configuration }),
    configuredNames,
    registrations,
  };
}

function methodClientContract(
  method: ConnectorCatalogAuthMethod,
): ConnectorAuthProviderMethodContract["client"] {
  const client = method.client;
  if (client === undefined) {
    return { kind: "none" };
  }
  if (client.clientRegistration === "dynamic") {
    return { kind: "dynamic-public" };
  }
  if (client.clientType === "confidential") {
    return "clientIdEnv" in client
      ? {
          kind: "static-confidential-env",
          clientIdEnv: client.clientIdEnv,
          clientSecretEnv: client.clientSecretEnv,
        }
      : { kind: "static-confidential-literal" };
  }
  return { kind: "static-public-literal" };
}

type ExecutableCatalogAuthMethod = ConnectorCatalogAuthMethod & {
  readonly grant: Exclude<
    ConnectorCatalogAuthMethod["grant"],
    { kind: "none" | "automatic" }
  >;
  readonly access: Exclude<
    ConnectorCatalogAuthMethod["access"],
    { kind: "none" | "automatic" }
  >;
};

function hasExecutableAuthShape(
  method: ConnectorCatalogAuthMethod,
): method is ExecutableCatalogAuthMethod {
  return (
    method.grant.kind !== "none" &&
    method.grant.kind !== "automatic" &&
    method.access.kind !== "none" &&
    method.access.kind !== "automatic"
  );
}

function methodContract(
  method: ExecutableCatalogAuthMethod,
): ConnectorAuthProviderMethodContract {
  const grantOutputNames =
    method.grant.kind === "manual"
      ? []
      : Object.keys(method.grant.outputs).sort(compareStrings);
  const startOptionNames =
    method.grant.kind === "device-auth"
      ? method.grant.startOptions
          .map((option) => {
            return option.privateName;
          })
          .sort(compareStrings)
      : [];
  return {
    client: methodClientContract(method),
    grant: {
      kind: method.grant.kind,
      callbackOrigin:
        method.grant.kind === "auth-code" || method.grant.kind === "openid-auth"
          ? method.grant.callbackOrigin
          : null,
      outputNames: grantOutputNames,
      startOptionNames,
    },
    access: {
      kind: method.access.kind,
      inputNames:
        method.access.kind === "refresh-token"
          ? Object.keys(method.access.inputs).sort(compareStrings)
          : [],
      outputNames:
        method.access.kind === "refresh-token"
          ? Object.keys(method.access.outputs).sort(compareStrings)
          : [],
      platformSecrets: [...(method.access.platformSecrets ?? [])].sort(
        compareStrings,
      ),
    },
    revoke: {
      kind: method.revoke.kind,
      inputNames:
        method.revoke.kind === "token-revoke"
          ? Object.keys(method.revoke.inputs).sort(compareStrings)
          : [],
    },
  };
}

function addProviderReasons(
  reasons: Set<ConnectorCatalogCompatibilityReason>,
  method: ConnectorCatalogAuthMethod,
  registration: ConnectorAuthProviderRegistrationCapability | undefined,
): void {
  if (
    method.grant.kind !== "manual" &&
    registration?.handlers.grant !== method.grant.kind
  ) {
    reasons.add("missing-grant-provider");
  }
  if (
    method.access.kind === "none" ||
    method.access.kind === "automatic" ||
    (method.access.kind === "refresh-token" &&
      registration?.handlers.access !== "refresh-token")
  ) {
    reasons.add("missing-access-provider");
  }
  if (
    method.revoke.kind === "token-revoke" &&
    registration?.handlers.revoke !== "token-revoke"
  ) {
    reasons.add("missing-revoke-provider");
  }
}

function hasUnapprovedConfigurationIdentity(
  contract: ConnectorAuthProviderMethodContract,
): boolean {
  return (
    contract.client.kind === "static-confidential-env" ||
    contract.client.kind === "static-public-env" ||
    contract.access.platformSecrets.length > 0
  );
}

function evaluateMethod(args: {
  readonly unsupportedProtocol: boolean;
  readonly method: ConnectorCatalogAuthMethod;
  readonly registration:
    | ConnectorAuthProviderRegistrationCapability
    | undefined;
  readonly configuredNames: ReadonlySet<string>;
}): ConnectorCatalogCompatibilityReason[] {
  const reasons = new Set<ConnectorCatalogCompatibilityReason>();
  if (args.unsupportedProtocol) {
    reasons.add("unsupported-protocol");
  }
  addProviderReasons(reasons, args.method, args.registration);

  if (!hasExecutableAuthShape(args.method)) {
    return COMPATIBILITY_REASON_ORDER.filter((reason) => {
      return reasons.has(reason);
    });
  }

  const contract = methodContract(args.method);
  const contractMatches =
    args.registration === undefined
      ? !hasUnapprovedConfigurationIdentity(contract)
      : JSON.stringify(args.registration.contract) === JSON.stringify(contract);
  if (!contractMatches) {
    reasons.add("provider-contract-mismatch");
  } else if (
    args.registration?.requiredConfigurationNames.some((name) => {
      return !args.configuredNames.has(name);
    })
  ) {
    reasons.add("missing-platform-configuration");
  }

  return COMPATIBILITY_REASON_ORDER.filter((reason) => {
    return reasons.has(reason);
  });
}

export function evaluateConnectorCatalogCompatibility(args: {
  readonly artifact: ConnectorCatalogArtifact;
  readonly capability: ExecutableCapabilityState;
}) {
  const registrations = new Map(
    args.capability.registrations.map((registration) => {
      return [
        registrationKey(registration.connectorSlug, registration.authMethodId),
        registration,
      ];
    }),
  );
  const filtered = args.artifact.connectors.flatMap((connector) => {
    return connector.authMethods.flatMap((method) => {
      const reasons = evaluateMethod({
        unsupportedProtocol: connector.mcp !== undefined,
        method,
        registration: registrations.get(
          registrationKey(connector.slug, method.id),
        ),
        configuredNames: args.capability.configuredNames,
      });
      return reasons.length === 0
        ? []
        : [
            {
              connectorSlug: connector.slug,
              authMethodId: method.id,
              reasons,
            },
          ];
    });
  });
  return filtered.sort((left, right) => {
    return (
      compareStrings(left.connectorSlug, right.connectorSlug) ||
      compareStrings(left.authMethodId, right.authMethodId)
    );
  });
}
