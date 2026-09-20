import {
  type ConnectorAuthMethodRuntimeConfig,
  type ConnectorDeviceAuthStartOptions,
  type ConnectorAuthCodeGrantConfig,
  type ConnectorExternalCodeGrantConfig,
  type ConnectorOpenIdAuthGrantConfig,
} from "@okouai/connectors/connector-config";
import {
  connectorAuthClientIdentity,
  connectorAuthMethodAccessMetadata,
  connectorGrantScopes,
  isStaticConnectorAuthClient,
  parseConnectorDeviceAuthStartOptionsConfig,
  resolveConnectorAuthClient,
  type ConnectorAuthClient,
  type ConnectorAuthClientIdentity,
  type ConnectorEnvReader,
  type StaticConnectorAuthClient,
} from "@okouai/connectors/connector-auth-method";
import type {
  AuthCodeConnectorAuthProvider,
  ConnectorAuthProviderRefreshResultBase,
  ConnectorAuthProviderRefreshResult,
  DeviceAuthConnectorAuthProvider,
  ExternalCodeConnectorAuthProvider,
  OpenIdAuthConnectorAuthProvider,
  RefreshTokenAccessProvider,
  TokenRevokeProvider,
} from "./types";
import type {
  ConnectorAuthProviderGrantResult,
  ConnectorAuthProviderGrantResultForMethod,
} from "./grant-result";
import {
  type AuthUrlResult,
  type ExternalCodeAuthorizationStartResult,
  type OAuthDeviceAuthPollResultBase,
  type OAuthDeviceAuthStartResult,
} from "./provider-flow-types";
import { providerEnvFromObject, type ProviderEnv } from "./provider-env";
import { authorizationScopesFromUrl } from "./oauth/scope";
import {
  CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS,
  type ConnectorAuthProviderAuthMethodId,
  type ConnectorAuthProviderAuthMethodIdByAccessKind,
  type ConnectorAuthProviderAuthMethodIdByGrantKind,
  type ConnectorAuthProviderConnectorSlug,
  type ConnectorAuthProviderConnectorSlugByAccessKind,
  type ConnectorAuthProviderConnectorSlugByGrantKind,
  type ConnectorAuthProviderClientContract,
  type ConnectorAuthProviderMethodContract,
} from "./provider-capabilities";
import { ahrefsProvider } from "./connectors/ahrefs/provider";
import { airtableProvider } from "./connectors/airtable/provider";
import { asanaProvider } from "./connectors/asana/provider";
import { awsProvider } from "./connectors/aws/provider";
import { base44Provider } from "./connectors/base44/provider";
import { boxProvider } from "./connectors/box/provider";
import { calComProvider } from "./connectors/cal-com/provider";
import { calendlyProvider } from "./connectors/calendly/provider";
import { canvaProvider } from "./connectors/canva/provider";
import { closeProvider } from "./connectors/close/provider";
import { copperProvider } from "./connectors/copper/provider";
import { cloudflareProvider } from "./connectors/cloudflare/provider";
import { deelProvider } from "./connectors/deel/provider";
import { datadogProvider } from "./connectors/datadog/provider";
import { docusignProvider } from "./connectors/docusign/provider";
import { dropboxProvider } from "./connectors/dropbox/provider";
import { figmaProvider } from "./connectors/figma/provider";
import { garminConnectProvider } from "./connectors/garmin-connect/provider";
import { gumroadProvider } from "./connectors/gumroad/provider";
import { githubProvider } from "./connectors/github/provider";
import { gmailProvider } from "./connectors/gmail/provider";
import { hubspotProvider } from "./connectors/hubspot/provider";
import { googleAdsProvider } from "./connectors/google-ads/provider";
import { googleAnalyticsProvider } from "./connectors/google-analytics/provider";
import { googleCalendarProvider } from "./connectors/google-calendar/provider";
import { googleCloudProvider } from "./connectors/google-cloud/provider";
import { googleContactsProvider } from "./connectors/google-contacts/provider";
import { googleDocsProvider } from "./connectors/google-docs/provider";
import { googleDriveProvider } from "./connectors/google-drive/provider";
import { googleFormsProvider } from "./connectors/google-forms/provider";
import { googleMapsProvider } from "./connectors/google-maps/provider";
import { googleMeetProvider } from "./connectors/google-meet/provider";
import { googleSearchConsoleProvider } from "./connectors/google-search-console/provider";
import { googleSheetsProvider } from "./connectors/google-sheets/provider";
import { larkProvider } from "./connectors/lark/provider";
import { linearProvider } from "./connectors/linear/provider";
import { mailchimpProvider } from "./connectors/mailchimp/provider";
import { mercuryProvider } from "./connectors/mercury/provider";
import { microsoft365Provider } from "./connectors/microsoft-365/provider";
import { mondayProvider } from "./connectors/monday/provider";
import { neonProvider } from "./connectors/neon/provider";
import { nintendoSwitchParentalControlsProvider } from "./connectors/nintendo-switch-parental-controls/provider";
import { nintendoStoreProvider } from "./connectors/nintendo-store/provider";
import { notionProvider } from "./connectors/notion/provider";
import { netsuiteProvider } from "./connectors/netsuite/provider";
import { optimizelyCmpProvider } from "./connectors/optimizely-cmp/provider";
import { otoProvider } from "./connectors/oto/provider";
import { noyoProvider } from "./connectors/noyo/provider";
import { outlookCalendarProvider } from "./connectors/outlook-calendar/provider";
import { outlookMailProvider } from "./connectors/outlook-mail/provider";
import { resourceGuruProvider } from "./connectors/resource-guru/provider";
import { redditProvider } from "./connectors/reddit/provider";
import { intervalsIcuProvider } from "./connectors/intervals-icu/provider";
import { sentryProvider } from "./connectors/sentry/provider";
import { slackProvider } from "./connectors/slack/provider";
import { slockProvider } from "./connectors/slock/provider";
import { stravaProvider } from "./connectors/strava/provider";
import {
  stripeCliProvider,
  stripeProvider,
} from "./connectors/stripe/provider";
import { todoistProvider } from "./connectors/todoist/provider";
import { vercelProvider } from "./connectors/vercel/provider";
import { webflowProvider } from "./connectors/webflow/provider";
import { supabaseProvider } from "./connectors/supabase/provider";
import { metaAdsProvider } from "./connectors/meta-ads/provider";
import { posthogProvider } from "./connectors/posthog/provider";
import { paypalProvider } from "./connectors/paypal/provider";
import { procountorProvider } from "./connectors/procountor/provider";
import { quickbooksProvider } from "./connectors/quickbooks/provider";
import { rampProvider } from "./connectors/ramp/provider";
import { reckonProvider } from "./connectors/reckon/provider";
import { playstationProvider } from "./connectors/playstation/provider";
import { spotifyProvider } from "./connectors/spotify/provider";
import { steamProvider } from "./connectors/steam/provider";
import { tiktokAdsProvider } from "./connectors/tiktok-ads/provider";
import { xProvider } from "./connectors/x/provider";
import { xeroProvider } from "./connectors/xero/provider";
import { youtubeProvider } from "./connectors/youtube/provider";
import { zoomProvider } from "./connectors/zoom/provider";
import { workdayProvider } from "./connectors/workday/provider";
import {
  testOauthApiTokenProvider,
  testOauthApiProvider,
  testOauthProvider,
} from "./connectors/test-oauth/provider";
import {
  testOauthDeviceApiProvider,
  testOauthDeviceProvider,
} from "./connectors/test-oauth-device/provider";

export type {
  ConnectorAuthProviderGrantResult,
  ConnectorAuthProviderGrantResultForMethod,
  ConnectorAuthProviderRefreshResultBase,
  ConnectorAuthProviderRefreshResult,
  ConnectorAuthProviderClientContract,
  ConnectorAuthProviderMethodContract,
};
export type { ProviderEnv };
export { providerEnvFromObject };

export type ConnectorAuthProviderAccessTokenRevokeResult =
  | { readonly status: "revoked" }
  | { readonly status: "unsupported" };

type RuntimeAuthCodeGrantProvider = {
  readonly kind: "auth-code";
  buildAuthUrl(
    args: never,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  exchangeCode(args: never): Promise<ConnectorAuthProviderGrantResult>;
};

type RuntimeDeviceAuthGrantProvider = {
  readonly kind: "device-auth";
  startDeviceAuth(args: never): Promise<OAuthDeviceAuthStartResult>;
  pollDeviceAuth(args: never): Promise<OAuthDeviceAuthPollResultBase>;
};

type RuntimeOpenIdAuthGrantProvider = {
  readonly kind: "openid-auth";
  buildAuthUrl(
    args: never,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  verifyCallback(
    args: never,
    signal: AbortSignal,
  ): Promise<ConnectorAuthProviderGrantResult>;
};

type RuntimeExternalCodeGrantProvider = {
  readonly kind: "external-code";
  startExternalCodeAuthorization(
    args: never,
  ): Promise<ExternalCodeAuthorizationStartResult>;
  completeExternalCodeAuthorization(
    args: never,
    signal: AbortSignal,
  ): Promise<ConnectorAuthProviderGrantResult>;
};

type RuntimeGrantProvider =
  | RuntimeAuthCodeGrantProvider
  | RuntimeDeviceAuthGrantProvider
  | RuntimeOpenIdAuthGrantProvider
  | RuntimeExternalCodeGrantProvider;

type RuntimeRefreshTokenAccessProvider = {
  readonly kind: "refresh-token";
  refresh(
    args: never,
    signal: AbortSignal,
  ): Promise<ConnectorAuthProviderRefreshResultBase>;
};

type RuntimeTokenRevokeProvider = {
  readonly kind: "token-revoke";
  revokeToken(args: never, signal: AbortSignal): Promise<void>;
};

type RuntimeAuthProviderEntry = {
  readonly grant?: RuntimeGrantProvider;
  readonly access?: RuntimeRefreshTokenAccessProvider;
  readonly revoke?: RuntimeTokenRevokeProvider;
};

type RuntimeAuthProviderRegistration = {
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly entry: RuntimeAuthProviderEntry;
};

type PreparedRuntimeAuthProviderRegistration =
  RuntimeAuthProviderRegistration & {
    readonly capability: ConnectorAuthProviderRegistrationCapability;
  };

type RuntimeAuthProviderRegistry = ReadonlyMap<
  string,
  PreparedRuntimeAuthProviderRegistration
>;

export type ConnectorAuthProviderRegistryCapability = {
  readonly grant?: RuntimeGrantProvider["kind"];
  readonly access?: RuntimeRefreshTokenAccessProvider["kind"];
  readonly revoke?: RuntimeTokenRevokeProvider["kind"];
};

export type ConnectorAuthProviderRegistryCapabilities = Readonly<
  Record<
    string,
    Readonly<Record<string, ConnectorAuthProviderRegistryCapability>>
  >
>;

export const CONNECTOR_GENERIC_AUTH_CAPABILITY_VERSIONS = {
  manualGrant: 1,
  staticAccess: 1,
  noneRevoke: 1,
} as const;

export interface ConnectorAuthProviderRegistrationCapability {
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly handlers: ConnectorAuthProviderRegistryCapability;
  readonly contract: ConnectorAuthProviderMethodContract;
  readonly requiredConfigurationNames: readonly string[];
}

function compareCapabilityStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function connectorAuthProviderClientContract(
  method: ConnectorAuthMethodRuntimeConfig,
): ConnectorAuthProviderClientContract {
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
  return "clientIdEnv" in client
    ? { kind: "static-public-env", clientIdEnv: client.clientIdEnv }
    : { kind: "static-public-literal" };
}

function connectorAuthProviderMethodContract(
  method: ConnectorAuthMethodRuntimeConfig,
): ConnectorAuthProviderMethodContract {
  const callbackOrigin =
    method.grant.kind === "auth-code"
      ? (method.grant.callbackOrigin ?? "web")
      : method.grant.kind === "openid-auth"
        ? (method.grant.callbackOrigin ?? "api")
        : null;
  const grantOutputNames =
    method.grant.kind === "auth-code" ||
    method.grant.kind === "openid-auth" ||
    method.grant.kind === "external-code" ||
    method.grant.kind === "device-auth"
      ? Object.keys(method.grant.outputs).sort(compareCapabilityStrings)
      : [];
  const startOptionNames =
    method.grant.kind === "device-auth"
      ? Object.keys(method.grant.startOptions ?? {}).sort(
          compareCapabilityStrings,
        )
      : [];
  const accessInputNames =
    method.access.kind === "refresh-token"
      ? Object.keys(method.access.inputs).sort(compareCapabilityStrings)
      : [];
  const accessOutputNames =
    method.access.kind === "refresh-token"
      ? Object.keys(method.access.outputs).sort(compareCapabilityStrings)
      : [];
  const revokeInputNames =
    method.revoke.kind === "token-revoke"
      ? Object.keys(method.revoke.inputs).sort(compareCapabilityStrings)
      : [];

  return {
    client: connectorAuthProviderClientContract(method),
    grant: {
      kind: method.grant.kind,
      callbackOrigin,
      outputNames: grantOutputNames,
      startOptionNames,
    },
    access: {
      kind: method.access.kind,
      inputNames: accessInputNames,
      outputNames: accessOutputNames,
      platformSecrets:
        method.access.kind === "none" || method.access.kind === "automatic"
          ? []
          : [...(method.access.platformSecrets ?? [])].sort(
              compareCapabilityStrings,
            ),
    },
    revoke: {
      kind: method.revoke.kind,
      inputNames: revokeInputNames,
    },
  };
}

function connectorAuthProviderRequiredConfigurationNames(
  contract: ConnectorAuthProviderMethodContract,
): readonly string[] {
  const names = new Set<string>();
  switch (contract.client.kind) {
    case "static-confidential-env":
      names.add(contract.client.clientIdEnv);
      names.add(contract.client.clientSecretEnv);
      break;
    case "static-public-env":
      names.add(contract.client.clientIdEnv);
      break;
    case "none":
    case "static-confidential-literal":
    case "static-public-literal":
    case "dynamic-public":
      break;
  }
  for (const name of contract.access.platformSecrets) {
    names.add(name);
  }
  return [...names].sort(compareCapabilityStrings);
}

function connectorAuthProviderRegistryCapability(
  entry: RuntimeAuthProviderEntry,
): ConnectorAuthProviderRegistryCapability {
  return {
    ...(entry.grant === undefined ? {} : { grant: entry.grant.kind }),
    ...(entry.access === undefined ? {} : { access: entry.access.kind }),
    ...(entry.revoke === undefined ? {} : { revoke: entry.revoke.kind }),
  };
}

function connectorAuthProviderRegistrationCapability(
  registration: RuntimeAuthProviderRegistration,
  contract: ConnectorAuthProviderMethodContract,
): ConnectorAuthProviderRegistrationCapability {
  return {
    connectorSlug: registration.connectorSlug,
    authMethodId: registration.authMethodId,
    handlers: connectorAuthProviderRegistryCapability(registration.entry),
    contract,
    requiredConfigurationNames:
      connectorAuthProviderRequiredConfigurationNames(contract),
  };
}

type MutableConnectorAuthProviderRegistryCapabilities = Record<
  string,
  Record<string, ConnectorAuthProviderRegistryCapability>
>;

function connectorAuthProviderRegistryEntry<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
>(
  connectorSlug: ConnectorSlug,
  authMethodId: AuthMethodId,
  entry: RuntimeAuthProviderEntry,
): RuntimeAuthProviderRegistration {
  return { connectorSlug, authMethodId, entry };
}

function assertConnectorAuthProviderHandlerKind(args: {
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly lifecycle: "grant" | "access" | "revoke";
  readonly expected: string | undefined;
  readonly actual: string | undefined;
}): void {
  if (args.expected !== args.actual) {
    throw new Error(
      `Auth provider ${args.lifecycle} handler mismatch for ${args.connectorSlug}:${args.authMethodId}`,
    );
  }
}

function assertConnectorAuthProviderEntryMatchesContract(
  registration: RuntimeAuthProviderRegistration,
  contract: ConnectorAuthProviderMethodContract,
): void {
  const handlers = connectorAuthProviderRegistryCapability(registration.entry);
  const expectedGrant =
    contract.grant.kind === "auth-code" ||
    contract.grant.kind === "openid-auth" ||
    contract.grant.kind === "external-code" ||
    contract.grant.kind === "device-auth"
      ? contract.grant.kind
      : undefined;
  assertConnectorAuthProviderHandlerKind({
    connectorSlug: registration.connectorSlug,
    authMethodId: registration.authMethodId,
    lifecycle: "grant",
    expected: expectedGrant,
    actual: handlers.grant,
  });
  assertConnectorAuthProviderHandlerKind({
    connectorSlug: registration.connectorSlug,
    authMethodId: registration.authMethodId,
    lifecycle: "access",
    expected:
      contract.access.kind === "refresh-token" ? "refresh-token" : undefined,
    actual: handlers.access,
  });
  assertConnectorAuthProviderHandlerKind({
    connectorSlug: registration.connectorSlug,
    authMethodId: registration.authMethodId,
    lifecycle: "revoke",
    expected:
      contract.revoke.kind === "token-revoke" ? "token-revoke" : undefined,
    actual: handlers.revoke,
  });
}

function buildRuntimeProviderRegistry(
  registrations: readonly RuntimeAuthProviderRegistration[],
): RuntimeAuthProviderRegistry {
  const contracts = new Map<string, ConnectorAuthProviderMethodContract>();
  for (const registration of CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS) {
    const key = connectorAuthProviderRegistrationKey(
      registration.connectorSlug,
      registration.authMethodId,
    );
    if (contracts.has(key)) {
      throw new Error(
        `Duplicate auth provider contract for ${registration.connectorSlug}:${registration.authMethodId}`,
      );
    }
    contracts.set(key, registration.contract);
  }

  const registry = new Map<string, PreparedRuntimeAuthProviderRegistration>();
  for (const registration of registrations) {
    const key = connectorAuthProviderRegistrationKey(
      registration.connectorSlug,
      registration.authMethodId,
    );
    if (registry.has(key)) {
      throw new Error(
        `Duplicate auth provider registration for ${registration.connectorSlug}:${registration.authMethodId}`,
      );
    }
    const contract = contracts.get(key);
    if (contract === undefined) {
      throw new Error(
        `Missing auth provider contract for ${registration.connectorSlug}:${registration.authMethodId}`,
      );
    }
    assertConnectorAuthProviderEntryMatchesContract(registration, contract);
    registry.set(key, {
      ...registration,
      capability: connectorAuthProviderRegistrationCapability(
        registration,
        contract,
      ),
    });
    contracts.delete(key);
  }
  if (contracts.size > 0) {
    throw new Error(
      `Missing auth provider registrations for ${[...contracts.keys()]
        .map((key) => {
          return key.replace("\0", ":");
        })
        .join(", ")}`,
    );
  }
  return registry;
}

function connectorAuthProviderRegistrationKey(
  connectorSlug: string,
  authMethodId: string,
): string {
  return `${connectorSlug}\0${authMethodId}`;
}

function getRuntimeAuthProviderRegistration(
  connectorSlug: string,
  authMethodId: string,
): PreparedRuntimeAuthProviderRegistration {
  const registration = CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY.get(
    connectorAuthProviderRegistrationKey(connectorSlug, authMethodId),
  );
  if (registration === undefined) {
    throw new Error(
      `Missing auth provider registration for ${connectorSlug}:${authMethodId}`,
    );
  }
  return registration;
}

function authCodeProviderEntry<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"auth-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "auth-code"
  >,
>(
  connectorSlug: ConnectorSlug,
  authMethodId: AuthMethodId,
  provider: AuthCodeConnectorAuthProvider<ConnectorSlug, AuthMethodId>,
): RuntimeAuthProviderRegistration {
  return connectorAuthProviderRegistryEntry(connectorSlug, authMethodId, {
    grant: provider.grant,
  });
}

function authCodeRefreshProviderEntry<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"auth-code"> &
      ConnectorAuthProviderConnectorSlugByAccessKind<"refresh-token">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "auth-code"
  > &
    ConnectorAuthProviderAuthMethodIdByAccessKind<
      ConnectorSlug,
      "refresh-token"
    >,
>(
  connectorSlug: ConnectorSlug,
  authMethodId: AuthMethodId,
  provider: AuthCodeConnectorAuthProvider<ConnectorSlug, AuthMethodId> & {
    readonly access: RefreshTokenAccessProvider<ConnectorSlug, AuthMethodId>;
  },
): RuntimeAuthProviderRegistration {
  return connectorAuthProviderRegistryEntry(connectorSlug, authMethodId, {
    grant: provider.grant,
    access: provider.access,
  });
}

function authCodeTokenRevokeProviderEntry<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"auth-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "auth-code"
  >,
>(
  connectorSlug: ConnectorSlug,
  authMethodId: AuthMethodId,
  provider: AuthCodeConnectorAuthProvider<ConnectorSlug, AuthMethodId> & {
    readonly revoke: TokenRevokeProvider<ConnectorSlug, AuthMethodId>;
  },
): RuntimeAuthProviderRegistration {
  return connectorAuthProviderRegistryEntry(connectorSlug, authMethodId, {
    grant: provider.grant,
    revoke: provider.revoke,
  });
}

function authCodeRefreshTokenRevokeProviderEntry<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"auth-code"> &
      ConnectorAuthProviderConnectorSlugByAccessKind<"refresh-token">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "auth-code"
  > &
    ConnectorAuthProviderAuthMethodIdByAccessKind<
      ConnectorSlug,
      "refresh-token"
    >,
>(
  connectorSlug: ConnectorSlug,
  authMethodId: AuthMethodId,
  provider: AuthCodeConnectorAuthProvider<ConnectorSlug, AuthMethodId> & {
    readonly access: RefreshTokenAccessProvider<ConnectorSlug, AuthMethodId>;
    readonly revoke: TokenRevokeProvider<ConnectorSlug, AuthMethodId>;
  },
): RuntimeAuthProviderRegistration {
  return connectorAuthProviderRegistryEntry(connectorSlug, authMethodId, {
    grant: provider.grant,
    access: provider.access,
    revoke: provider.revoke,
  });
}

function deviceAuthProviderEntry<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  >,
>(
  connectorSlug: ConnectorSlug,
  authMethodId: AuthMethodId,
  provider: DeviceAuthConnectorAuthProvider<ConnectorSlug, AuthMethodId>,
): RuntimeAuthProviderRegistration {
  return connectorAuthProviderRegistryEntry(connectorSlug, authMethodId, {
    grant: provider.grant,
  });
}

function openIdAuthProviderEntry<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"openid-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "openid-auth"
  >,
>(
  connectorSlug: ConnectorSlug,
  authMethodId: AuthMethodId,
  provider: OpenIdAuthConnectorAuthProvider<ConnectorSlug, AuthMethodId>,
): RuntimeAuthProviderRegistration {
  return connectorAuthProviderRegistryEntry(connectorSlug, authMethodId, {
    grant: provider.grant,
  });
}

function deviceAuthRefreshProviderEntry<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"device-auth"> &
      ConnectorAuthProviderConnectorSlugByAccessKind<"refresh-token">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  > &
    ConnectorAuthProviderAuthMethodIdByAccessKind<
      ConnectorSlug,
      "refresh-token"
    >,
>(
  connectorSlug: ConnectorSlug,
  authMethodId: AuthMethodId,
  provider: DeviceAuthConnectorAuthProvider<ConnectorSlug, AuthMethodId> & {
    readonly access: RefreshTokenAccessProvider<ConnectorSlug, AuthMethodId>;
  },
): RuntimeAuthProviderRegistration {
  return connectorAuthProviderRegistryEntry(connectorSlug, authMethodId, {
    grant: provider.grant,
    access: provider.access,
  });
}

function externalCodeRefreshProviderEntry<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"external-code"> &
      ConnectorAuthProviderConnectorSlugByAccessKind<"refresh-token">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "external-code"
  > &
    ConnectorAuthProviderAuthMethodIdByAccessKind<
      ConnectorSlug,
      "refresh-token"
    >,
>(
  connectorSlug: ConnectorSlug,
  authMethodId: AuthMethodId,
  provider: ExternalCodeConnectorAuthProvider<ConnectorSlug, AuthMethodId> & {
    readonly access: RefreshTokenAccessProvider<ConnectorSlug, AuthMethodId>;
  },
): RuntimeAuthProviderRegistration {
  return connectorAuthProviderRegistryEntry(connectorSlug, authMethodId, {
    grant: provider.grant,
    access: provider.access,
  });
}

function externalCodeRefreshTokenRevokeProviderEntry<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"external-code"> &
      ConnectorAuthProviderConnectorSlugByAccessKind<"refresh-token">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "external-code"
  > &
    ConnectorAuthProviderAuthMethodIdByAccessKind<
      ConnectorSlug,
      "refresh-token"
    >,
>(
  connectorSlug: ConnectorSlug,
  authMethodId: AuthMethodId,
  provider: ExternalCodeConnectorAuthProvider<ConnectorSlug, AuthMethodId> & {
    readonly access: RefreshTokenAccessProvider<ConnectorSlug, AuthMethodId>;
    readonly revoke: TokenRevokeProvider<ConnectorSlug, AuthMethodId>;
  },
): RuntimeAuthProviderRegistration {
  return connectorAuthProviderRegistryEntry(connectorSlug, authMethodId, {
    grant: provider.grant,
    access: provider.access,
    revoke: provider.revoke,
  });
}

function refreshProviderEntry<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByAccessKind<"refresh-token">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByAccessKind<
    ConnectorSlug,
    "refresh-token"
  >,
>(
  connectorSlug: ConnectorSlug,
  authMethodId: AuthMethodId,
  provider: {
    readonly access: RefreshTokenAccessProvider<ConnectorSlug, AuthMethodId>;
  },
): RuntimeAuthProviderRegistration {
  return connectorAuthProviderRegistryEntry(connectorSlug, authMethodId, {
    access: provider.access,
  });
}

export interface ConnectorAuthProviderMethodSelection {
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
}

function assertConnectorAuthProviderMethodContract(
  selection: ConnectorAuthProviderMethodSelection,
  registration: PreparedRuntimeAuthProviderRegistration,
): void {
  if (
    JSON.stringify(connectorAuthProviderMethodContract(selection.method)) !==
    JSON.stringify(registration.capability.contract)
  ) {
    throw new Error(
      `Auth provider contract mismatch for ${selection.connectorSlug}:${selection.authMethodId}`,
    );
  }
}

function connectorAuthProviderRegistrationFor(
  selection: ConnectorAuthProviderMethodSelection,
): PreparedRuntimeAuthProviderRegistration {
  const registration = getRuntimeAuthProviderRegistration(
    selection.connectorSlug,
    selection.authMethodId,
  );
  assertConnectorAuthProviderMethodContract(selection, registration);
  return registration;
}

function connectorAuthCodeGrantProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeAuthCodeGrantProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { grant } = registration.entry;
  if (grant?.kind !== "auth-code") {
    throw new Error(
      `Missing auth-code grant provider for ${selection.connectorSlug}:${selection.authMethodId}`,
    );
  }
  return grant;
}

function connectorDeviceAuthGrantProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeDeviceAuthGrantProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { grant } = registration.entry;
  if (grant?.kind !== "device-auth") {
    throw new Error(
      `Missing device-auth grant provider for ${selection.connectorSlug}:${selection.authMethodId}`,
    );
  }
  return grant;
}

function connectorOpenIdAuthGrantProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeOpenIdAuthGrantProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { grant } = registration.entry;
  if (grant?.kind !== "openid-auth") {
    throw new Error(
      `Missing openid-auth grant provider for ${selection.connectorSlug}:${selection.authMethodId}`,
    );
  }
  return grant;
}

function connectorExternalCodeGrantProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeExternalCodeGrantProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { grant } = registration.entry;
  if (grant?.kind !== "external-code") {
    throw new Error(
      `Missing external-code grant provider for ${selection.connectorSlug}:${selection.authMethodId}`,
    );
  }
  return grant;
}

function connectorRefreshTokenAccessProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeRefreshTokenAccessProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { access } = registration.entry;
  if (access?.kind !== "refresh-token") {
    throw new Error(
      `Missing refresh-token access provider for ${selection.connectorSlug}:${selection.authMethodId}`,
    );
  }
  return access;
}

function connectorTokenRevokeProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeTokenRevokeProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { revoke } = registration.entry;
  if (revoke?.kind !== "token-revoke") {
    throw new Error(
      `Missing token-revoke provider for ${selection.connectorSlug}:${selection.authMethodId}`,
    );
  }
  return revoke;
}

function invokeRuntimeProvider<Args, Result>(
  handler: (args: never) => Result,
  args: Args,
): Result {
  // Typed registry builders establish the handler/method relation. Exact
  // runtime contract validation restores it after the open-key lookup.
  return (handler as (input: Args) => Result)(args);
}

function invokeRuntimeProviderWithSignal<Args, Result>(
  handler: (args: never, signal: AbortSignal) => Result,
  args: Args,
  signal: AbortSignal,
): Result {
  // Typed registry builders establish the handler/method relation. Exact
  // runtime contract validation restores it after the open-key lookup.
  return (handler as (input: Args, signal: AbortSignal) => Result)(
    args,
    signal,
  );
}

function assertConnectorAuthClientMatchesMethod(args: {
  readonly selection: ConnectorAuthProviderMethodSelection;
  readonly authClient: ConnectorAuthClient;
}): void {
  const client = args.selection.method.client;
  if (client === undefined) {
    throw new Error(
      `Missing auth client configuration for ${args.selection.connectorSlug}:${args.selection.authMethodId}`,
    );
  }
  if (
    client.clientRegistration !== args.authClient.clientRegistration ||
    client.clientType !== args.authClient.clientType
  ) {
    throw new Error(
      `Auth client does not match ${args.selection.connectorSlug}:${args.selection.authMethodId}`,
    );
  }
  if (
    client.clientRegistration === "static" &&
    "clientId" in client &&
    (args.authClient.clientRegistration !== "static" ||
      client.clientId !== args.authClient.clientId)
  ) {
    throw new Error(
      `Auth client does not match ${args.selection.connectorSlug}:${args.selection.authMethodId}`,
    );
  }
  if (
    client.clientRegistration === "static" &&
    client.clientType === "confidential" &&
    "clientSecret" in client &&
    (args.authClient.clientRegistration !== "static" ||
      args.authClient.clientType !== "confidential" ||
      client.clientSecret !== args.authClient.clientSecret)
  ) {
    throw new Error(
      `Auth client does not match ${args.selection.connectorSlug}:${args.selection.authMethodId}`,
    );
  }
}

function assertDeclaredProviderOutputs(args: {
  readonly selection: ConnectorAuthProviderMethodSelection;
  readonly operation: "grant" | "refresh";
  readonly declaredOutputNames: readonly string[];
  readonly outputs: Readonly<Record<string, string | null | undefined>>;
}): void {
  const declaredOutputs = new Set(args.declaredOutputNames);
  for (const outputName of Object.keys(args.outputs)) {
    if (!declaredOutputs.has(outputName)) {
      throw new Error(
        `${args.selection.connectorSlug} connector auth method ${args.selection.authMethodId} returned undeclared ${args.operation} output ${outputName}`,
      );
    }
  }
}

function assertDeclaredProviderInputs(args: {
  readonly selection: ConnectorAuthProviderMethodSelection;
  readonly operation: "refresh" | "revoke";
  readonly declaredInputNames: readonly string[];
  readonly inputs: Readonly<Record<string, string>>;
}): void {
  const declaredInputs = new Set(args.declaredInputNames);
  for (const inputName of Object.keys(args.inputs)) {
    if (!declaredInputs.has(inputName)) {
      throw new Error(
        `${args.selection.connectorSlug} connector auth method ${args.selection.authMethodId} received undeclared ${args.operation} input ${inputName}`,
      );
    }
  }
  for (const inputName of declaredInputs) {
    if (!Object.hasOwn(args.inputs, inputName)) {
      throw new Error(
        `${args.selection.connectorSlug} connector auth method ${args.selection.authMethodId} is missing ${args.operation} input ${inputName}`,
      );
    }
  }
}

const CONNECTOR_AUTH_METHOD_PROVIDER_ENTRIES = [
  authCodeRefreshProviderEntry("ahrefs", "oauth", ahrefsProvider),
  authCodeRefreshProviderEntry("airtable", "oauth", airtableProvider),
  authCodeRefreshProviderEntry("asana", "oauth", asanaProvider),
  externalCodeRefreshProviderEntry("aws", "cli", awsProvider),
  deviceAuthRefreshProviderEntry("base44", "oauth", base44Provider),
  authCodeRefreshProviderEntry("box", "oauth", boxProvider),
  authCodeRefreshProviderEntry("cal-com", "oauth", calComProvider),
  authCodeRefreshTokenRevokeProviderEntry(
    "calendly",
    "oauth",
    calendlyProvider,
  ),
  authCodeRefreshProviderEntry("canva", "oauth", canvaProvider),
  authCodeRefreshProviderEntry("close", "oauth", closeProvider),
  authCodeProviderEntry("copper", "oauth", copperProvider),
  authCodeRefreshTokenRevokeProviderEntry(
    "cloudflare",
    "oauth",
    cloudflareProvider,
  ),
  authCodeRefreshProviderEntry("deel", "oauth", deelProvider),
  authCodeRefreshProviderEntry("datadog", "oauth", datadogProvider),
  authCodeRefreshProviderEntry("docusign", "oauth", docusignProvider),
  authCodeRefreshProviderEntry("dropbox", "oauth", dropboxProvider),
  authCodeRefreshProviderEntry("figma", "oauth", figmaProvider),
  authCodeRefreshProviderEntry(
    "garmin-connect",
    "oauth",
    garminConnectProvider,
  ),
  authCodeTokenRevokeProviderEntry("github", "oauth", githubProvider),
  authCodeRefreshProviderEntry("gmail", "oauth", gmailProvider),
  authCodeRefreshProviderEntry("google-ads", "oauth", googleAdsProvider),
  authCodeRefreshProviderEntry(
    "google-analytics",
    "oauth",
    googleAnalyticsProvider,
  ),
  authCodeRefreshProviderEntry(
    "google-calendar",
    "oauth",
    googleCalendarProvider,
  ),
  authCodeRefreshProviderEntry("google-cloud", "oauth", googleCloudProvider),
  authCodeRefreshProviderEntry(
    "google-contacts",
    "oauth",
    googleContactsProvider,
  ),
  authCodeRefreshProviderEntry("google-docs", "oauth", googleDocsProvider),
  authCodeRefreshProviderEntry("google-drive", "oauth", googleDriveProvider),
  authCodeRefreshProviderEntry("google-forms", "oauth", googleFormsProvider),
  authCodeRefreshProviderEntry("google-maps", "oauth", googleMapsProvider),
  authCodeRefreshProviderEntry("google-meet", "oauth", googleMeetProvider),
  authCodeRefreshProviderEntry(
    "google-search-console",
    "oauth",
    googleSearchConsoleProvider,
  ),
  authCodeRefreshProviderEntry("google-sheets", "oauth", googleSheetsProvider),
  authCodeRefreshProviderEntry("gumroad", "oauth", gumroadProvider),
  authCodeRefreshProviderEntry("hubspot", "oauth", hubspotProvider),
  refreshProviderEntry("lark", "api-token", larkProvider),
  authCodeProviderEntry("intervals-icu", "oauth", intervalsIcuProvider),
  authCodeRefreshTokenRevokeProviderEntry("linear", "oauth", linearProvider),
  authCodeProviderEntry("mailchimp", "oauth", mailchimpProvider),
  authCodeRefreshProviderEntry("mercury", "oauth", mercuryProvider),
  authCodeRefreshProviderEntry("microsoft-365", "oauth", microsoft365Provider),
  authCodeRefreshProviderEntry("monday", "oauth", mondayProvider),
  authCodeRefreshProviderEntry("neon", "oauth", neonProvider),
  refreshProviderEntry("netsuite", "api-token", netsuiteProvider),
  externalCodeRefreshProviderEntry(
    "nintendo-store",
    "api",
    nintendoStoreProvider,
  ),
  externalCodeRefreshTokenRevokeProviderEntry(
    "nintendo-switch-parental-controls",
    "api",
    nintendoSwitchParentalControlsProvider,
  ),
  authCodeRefreshProviderEntry("notion", "oauth", notionProvider),
  authCodeRefreshTokenRevokeProviderEntry(
    "optimizely-cmp",
    "oauth",
    optimizelyCmpProvider,
  ),
  refreshProviderEntry("oto", "api-token", otoProvider),
  refreshProviderEntry("noyo", "api-token", noyoProvider),
  authCodeRefreshProviderEntry("resource-guru", "oauth", resourceGuruProvider),
  authCodeRefreshProviderEntry(
    "outlook-calendar",
    "oauth",
    outlookCalendarProvider,
  ),
  authCodeRefreshProviderEntry("outlook-mail", "oauth", outlookMailProvider),
  authCodeRefreshProviderEntry("posthog", "oauth", posthogProvider),
  refreshProviderEntry("paypal", "api-token", paypalProvider),
  refreshProviderEntry("procountor", "api-token", procountorProvider),
  externalCodeRefreshProviderEntry("playstation", "api", playstationProvider),
  authCodeRefreshProviderEntry("quickbooks", "oauth", quickbooksProvider),
  authCodeRefreshTokenRevokeProviderEntry("ramp", "oauth", rampProvider),
  refreshProviderEntry("reckon", "oauth-refresh-token", reckonProvider),
  authCodeRefreshProviderEntry("reddit", "oauth", redditProvider),
  authCodeRefreshProviderEntry("sentry", "oauth", sentryProvider),
  authCodeTokenRevokeProviderEntry("slack", "oauth", slackProvider),
  deviceAuthRefreshProviderEntry("slock", "oauth", slockProvider),
  authCodeRefreshProviderEntry("spotify", "oauth", spotifyProvider),
  openIdAuthProviderEntry("steam", "openid", steamProvider),
  authCodeRefreshProviderEntry("strava", "oauth", stravaProvider),
  authCodeRefreshProviderEntry("stripe", "oauth", stripeProvider),
  deviceAuthProviderEntry("stripe", "cli", stripeCliProvider),
  authCodeRefreshProviderEntry("supabase", "oauth", supabaseProvider),
  authCodeRefreshProviderEntry("test-oauth", "oauth", testOauthProvider),
  refreshProviderEntry("test-oauth", "api-token", testOauthApiTokenProvider),
  authCodeRefreshProviderEntry("test-oauth", "api", testOauthApiProvider),
  deviceAuthProviderEntry(
    "test-oauth-device",
    "oauth",
    testOauthDeviceProvider,
  ),
  deviceAuthProviderEntry(
    "test-oauth-device",
    "api",
    testOauthDeviceApiProvider,
  ),
  authCodeProviderEntry("todoist", "oauth", todoistProvider),
  authCodeProviderEntry("vercel", "oauth", vercelProvider),
  authCodeProviderEntry("webflow", "oauth", webflowProvider),
  authCodeRefreshProviderEntry("meta-ads", "oauth", metaAdsProvider),
  authCodeProviderEntry("tiktok-ads", "oauth", tiktokAdsProvider),
  authCodeRefreshProviderEntry("x", "oauth", xProvider),
  authCodeRefreshProviderEntry("xero", "oauth", xeroProvider),
  authCodeRefreshTokenRevokeProviderEntry("youtube", "oauth", youtubeProvider),
  authCodeRefreshProviderEntry("zoom", "oauth", zoomProvider),
  refreshProviderEntry("workday", "api-token", workdayProvider),
];

const CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY = buildRuntimeProviderRegistry(
  CONNECTOR_AUTH_METHOD_PROVIDER_ENTRIES,
);

export function getConnectorAuthProviderRegistryCapabilities(): ConnectorAuthProviderRegistryCapabilities {
  const capabilities: MutableConnectorAuthProviderRegistryCapabilities = {};
  for (const registration of CONNECTOR_AUTH_METHOD_PROVIDER_ENTRIES) {
    const methodCapabilities = capabilities[registration.connectorSlug] ?? {};
    methodCapabilities[registration.authMethodId] =
      connectorAuthProviderRegistryCapability(registration.entry);
    capabilities[registration.connectorSlug] = methodCapabilities;
  }
  return capabilities;
}

export function getConnectorAuthProviderRegistrationCapabilities(): readonly ConnectorAuthProviderRegistrationCapability[] {
  return CONNECTOR_AUTH_METHOD_PROVIDER_ENTRIES.map((registration) => {
    return structuredClone(
      getRuntimeAuthProviderRegistration(
        registration.connectorSlug,
        registration.authMethodId,
      ).capability,
    );
  }).sort((left, right) => {
    return (
      compareCapabilityStrings(left.connectorSlug, right.connectorSlug) ||
      compareCapabilityStrings(left.authMethodId, right.authMethodId)
    );
  });
}

interface RuntimeAuthCodeAuthorizeArgs {
  readonly authClient: ConnectorAuthClientIdentity;
  readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  readonly redirectUri: string;
  readonly state: string;
}

interface RuntimeAuthCodeExchangeArgs {
  readonly authClient: ConnectorAuthClient;
  readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}

interface RuntimeOpenIdAuthorizeArgs {
  readonly openIdAuthGrant: ConnectorOpenIdAuthGrantConfig;
  readonly returnTo: string;
  readonly realm: string;
  readonly state: string;
}

interface RuntimeOpenIdVerifyArgs {
  readonly openIdAuthGrant: ConnectorOpenIdAuthGrantConfig;
  readonly callbackParams: Readonly<Record<string, string>>;
  readonly expectedReturnTo: string;
  readonly expectedRealm: string;
}

interface RuntimeExternalCodeStartArgs {
  readonly authClient: ConnectorAuthClientIdentity;
  readonly externalCodeGrant: ConnectorExternalCodeGrantConfig;
}

interface RuntimeExternalCodeCompleteArgs {
  readonly authClient: ConnectorAuthClient;
  readonly externalCodeGrant: ConnectorExternalCodeGrantConfig;
  readonly code: string;
  readonly providerState: string;
}

interface RuntimeDeviceAuthorizationStartArgs {
  readonly authClient: ConnectorAuthClientIdentity;
  readonly scopes: readonly string[];
  readonly options: ConnectorDeviceAuthStartOptions;
}

interface RuntimeDeviceAuthorizationPollArgs {
  readonly authClient: ConnectorAuthClient;
  readonly deviceCode: string;
  readonly pollState?: string;
  readonly scopes: readonly string[];
}

interface RuntimeRefreshTokenAccessArgs {
  readonly authClient?: ConnectorAuthClient;
  readonly inputs: Readonly<Record<string, string>>;
}

interface RuntimeTokenRevokeArgs {
  readonly authClient: StaticConnectorAuthClient;
  readonly inputs: Readonly<Record<string, string>>;
}

function assertGrantOutputs(args: {
  readonly selection: ConnectorAuthProviderMethodSelection;
  readonly result: ConnectorAuthProviderGrantResult;
}): void {
  const { grant } = args.selection.method;
  if (
    grant.kind !== "auth-code" &&
    grant.kind !== "openid-auth" &&
    grant.kind !== "external-code" &&
    grant.kind !== "device-auth"
  ) {
    throw new Error(
      `Provider-backed grant required for ${args.selection.connectorSlug}:${args.selection.authMethodId}`,
    );
  }
  assertDeclaredProviderOutputs({
    selection: args.selection,
    operation: "grant",
    declaredOutputNames: Object.keys(grant.outputs),
    outputs: args.result.outputs,
  });
}

function assertOptionalConnectorAuthClientMatchesMethod(args: {
  readonly selection: ConnectorAuthProviderMethodSelection;
  readonly authClient: ConnectorAuthClient | undefined;
}): void {
  if (args.selection.method.client === undefined) {
    if (args.authClient !== undefined) {
      throw new Error(
        `Unexpected auth client for ${args.selection.connectorSlug}:${args.selection.authMethodId}`,
      );
    }
    return;
  }
  if (args.authClient === undefined) {
    throw new Error(
      `Missing auth client for ${args.selection.connectorSlug}:${args.selection.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args.selection,
    authClient: args.authClient,
  });
}

export async function buildConnectorAuthCodeAuthorizationUrlWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
    readonly redirectUri: string;
    readonly state: string;
  },
): Promise<string | AuthUrlResult> {
  const provider = connectorAuthCodeGrantProviderFor(args);
  if (args.method.grant.kind !== "auth-code") {
    throw new Error(
      `Auth-code grant required for ${args.connectorSlug}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  return await invokeRuntimeProvider<
    RuntimeAuthCodeAuthorizeArgs,
    string | AuthUrlResult | Promise<string | AuthUrlResult>
  >(provider.buildAuthUrl, {
    authClient: connectorAuthClientIdentity(args.authClient),
    authCodeGrant: args.method.grant,
    redirectUri: args.redirectUri,
    state: args.state,
  });
}

export async function buildConnectorOpenIdAuthAuthorizationUrlWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly returnTo: string;
    readonly realm: string;
    readonly state: string;
  },
): Promise<string | AuthUrlResult> {
  const provider = connectorOpenIdAuthGrantProviderFor(args);
  if (args.method.grant.kind !== "openid-auth") {
    throw new Error(
      `OpenID grant required for ${args.connectorSlug}:${args.authMethodId}`,
    );
  }
  return await invokeRuntimeProvider<
    RuntimeOpenIdAuthorizeArgs,
    string | AuthUrlResult | Promise<string | AuthUrlResult>
  >(provider.buildAuthUrl, {
    openIdAuthGrant: args.method.grant,
    returnTo: args.returnTo,
    realm: args.realm,
    state: args.state,
  });
}

export async function exchangeConnectorAuthCodeWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
    readonly authorizationUrl: string | null;
    readonly code: string;
    readonly redirectUri: string;
    readonly state: string | undefined;
    readonly codeVerifier: string | undefined;
    readonly oauthContext: string | undefined;
  },
): Promise<ConnectorAuthProviderGrantResult> {
  const provider = connectorAuthCodeGrantProviderFor(args);
  if (args.method.grant.kind !== "auth-code") {
    throw new Error(
      `Auth-code grant required for ${args.connectorSlug}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  const result = await invokeRuntimeProvider<
    RuntimeAuthCodeExchangeArgs,
    Promise<ConnectorAuthProviderGrantResult>
  >(provider.exchangeCode, {
    authClient: args.authClient,
    authCodeGrant: {
      ...args.method.grant,
      scopes: [
        ...((args.authorizationUrl
          ? authorizationScopesFromUrl(args.authorizationUrl)
          : undefined) ?? args.method.grant.scopes),
      ],
    },
    code: args.code,
    redirectUri: args.redirectUri,
    state: args.state,
    codeVerifier: args.codeVerifier,
    oauthContext: args.oauthContext,
  });
  assertGrantOutputs({ selection: args, result });
  return result;
}

export async function verifyConnectorOpenIdAuthCallbackWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly callbackParams: Readonly<Record<string, string>>;
    readonly expectedReturnTo: string;
    readonly expectedRealm: string;
  },
  signal: AbortSignal,
): Promise<ConnectorAuthProviderGrantResult> {
  const provider = connectorOpenIdAuthGrantProviderFor(args);
  if (args.method.grant.kind !== "openid-auth") {
    throw new Error(
      `OpenID grant required for ${args.connectorSlug}:${args.authMethodId}`,
    );
  }
  const result = await invokeRuntimeProviderWithSignal<
    RuntimeOpenIdVerifyArgs,
    Promise<ConnectorAuthProviderGrantResult>
  >(
    provider.verifyCallback,
    {
      openIdAuthGrant: args.method.grant,
      callbackParams: args.callbackParams,
      expectedReturnTo: args.expectedReturnTo,
      expectedRealm: args.expectedRealm,
    },
    signal,
  );
  assertGrantOutputs({ selection: args, result });
  return result;
}

export async function startConnectorExternalCodeAuthorizationWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
  },
): Promise<ExternalCodeAuthorizationStartResult> {
  const provider = connectorExternalCodeGrantProviderFor(args);
  if (args.method.grant.kind !== "external-code") {
    throw new Error(
      `External-code grant required for ${args.connectorSlug}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  return await invokeRuntimeProvider<
    RuntimeExternalCodeStartArgs,
    Promise<ExternalCodeAuthorizationStartResult>
  >(provider.startExternalCodeAuthorization, {
    authClient: connectorAuthClientIdentity(args.authClient),
    externalCodeGrant: args.method.grant,
  });
}

export async function completeConnectorExternalCodeAuthorizationWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
    readonly authorizationScopes: readonly string[];
    readonly code: string;
    readonly providerState: string;
  },
  signal: AbortSignal,
): Promise<ConnectorAuthProviderGrantResult> {
  const provider = connectorExternalCodeGrantProviderFor(args);
  if (args.method.grant.kind !== "external-code") {
    throw new Error(
      `External-code grant required for ${args.connectorSlug}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  const result = await invokeRuntimeProviderWithSignal<
    RuntimeExternalCodeCompleteArgs,
    Promise<ConnectorAuthProviderGrantResult>
  >(
    provider.completeExternalCodeAuthorization,
    {
      authClient: args.authClient,
      externalCodeGrant: {
        ...args.method.grant,
        scopes: [...args.authorizationScopes],
      },
      code: args.code,
      providerState: args.providerState,
    },
    signal,
  );
  assertGrantOutputs({ selection: args, result });
  return result;
}

export async function startConnectorDeviceAuthorizationWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
    readonly options: ConnectorDeviceAuthStartOptions;
  },
): Promise<OAuthDeviceAuthStartResult> {
  const provider = connectorDeviceAuthGrantProviderFor(args);
  if (args.method.grant.kind !== "device-auth") {
    throw new Error(
      `Device-auth grant required for ${args.connectorSlug}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  const startOptionsResult = parseConnectorDeviceAuthStartOptionsConfig({
    connectorSlug: args.connectorSlug,
    authMethodId: args.authMethodId,
    startOptions: args.method.grant.startOptions,
    options: args.options,
  });
  if (!startOptionsResult.success) {
    throw new Error(startOptionsResult.message);
  }
  return await invokeRuntimeProvider<
    RuntimeDeviceAuthorizationStartArgs,
    Promise<OAuthDeviceAuthStartResult>
  >(provider.startDeviceAuth, {
    authClient: connectorAuthClientIdentity(args.authClient),
    scopes: connectorGrantScopes(args.method.grant),
    options: startOptionsResult.options,
  });
}

export async function pollConnectorDeviceAuthorizationWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
    readonly deviceCode: string;
    readonly pollState?: string;
    readonly scopes: readonly string[];
  },
): Promise<OAuthDeviceAuthPollResultBase> {
  const provider = connectorDeviceAuthGrantProviderFor(args);
  if (args.method.grant.kind !== "device-auth") {
    throw new Error(
      `Device-auth grant required for ${args.connectorSlug}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  const result = await invokeRuntimeProvider<
    RuntimeDeviceAuthorizationPollArgs,
    Promise<OAuthDeviceAuthPollResultBase>
  >(provider.pollDeviceAuth, {
    authClient: args.authClient,
    deviceCode: args.deviceCode,
    scopes: args.scopes,
    ...(args.pollState === undefined ? {} : { pollState: args.pollState }),
  });
  if (result.status === "complete") {
    assertGrantOutputs({ selection: args, result: result.token });
  }
  return result;
}

export async function refreshConnectorAuthProviderAccessTokenWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient?: ConnectorAuthClient;
    readonly inputs: Readonly<Record<string, string>>;
  },
  signal: AbortSignal,
): Promise<ConnectorAuthProviderRefreshResultBase> {
  const access = connectorRefreshTokenAccessProviderFor(args);
  const accessMetadata = connectorAuthMethodAccessMetadata(args.method);
  if (accessMetadata.kind !== "refresh-token") {
    throw new Error(
      `Refresh-token access required for ${args.connectorSlug}:${args.authMethodId}`,
    );
  }
  assertOptionalConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  assertDeclaredProviderInputs({
    selection: args,
    operation: "refresh",
    declaredInputNames: Object.keys(accessMetadata.inputs),
    inputs: args.inputs,
  });
  const result = await invokeRuntimeProviderWithSignal<
    RuntimeRefreshTokenAccessArgs,
    Promise<ConnectorAuthProviderRefreshResultBase>
  >(
    access.refresh,
    {
      ...(args.authClient === undefined ? {} : { authClient: args.authClient }),
      inputs: args.inputs,
    },
    signal,
  );
  assertDeclaredProviderOutputs({
    selection: args,
    operation: "refresh",
    declaredOutputNames: Object.keys(accessMetadata.outputs),
    outputs: result.outputs,
  });
  return result;
}

export async function revokeConnectorAuthMethodAccessTokenWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly readEnv: ConnectorEnvReader;
    readonly loadInputs: () =>
      | Readonly<Record<string, string>>
      | Promise<Readonly<Record<string, string>>>;
  },
  signal: AbortSignal,
): Promise<ConnectorAuthProviderAccessTokenRevokeResult> {
  if (args.method.revoke.kind !== "token-revoke") {
    return { status: "unsupported" };
  }
  const revoke = connectorTokenRevokeProviderFor(args);
  const clientConfig = args.method.client;
  if (clientConfig === undefined) {
    return { status: "unsupported" };
  }
  const authClient = resolveConnectorAuthClient(clientConfig, args.readEnv);
  if (!authClient || !isStaticConnectorAuthClient(authClient)) {
    return { status: "unsupported" };
  }
  const inputs = await args.loadInputs();
  assertDeclaredProviderInputs({
    selection: args,
    operation: "revoke",
    declaredInputNames: Object.keys(args.method.revoke.inputs),
    inputs,
  });
  await invokeRuntimeProviderWithSignal<RuntimeTokenRevokeArgs, Promise<void>>(
    revoke.revokeToken,
    { authClient, inputs },
    signal,
  );
  return { status: "revoked" };
}
