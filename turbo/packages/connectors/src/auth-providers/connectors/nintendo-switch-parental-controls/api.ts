import * as z from "zod";

import type { ConnectorExternalCodeGrantConfig } from "@okouai/connectors/connector-config";
import type { ConnectorAuthProviderGrantUserInfo } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";
import { NINTENDO_SWITCH_PARENTAL_CONTROLS_APP } from "./app";
import {
  NINTENDO_ACCOUNT_AUTHORIZATION_URL,
  NINTENDO_ACCOUNT_PROFILE_URL,
  NINTENDO_ACCOUNT_SESSION_TOKEN_URL,
  NINTENDO_ACCOUNT_TOKEN_URL,
  buildNintendoAccountAuthorizationUrl,
  createNintendoAccountProviderState,
  exchangeNintendoAccountSessionToken,
  exchangeNintendoAccountSessionTokenCode,
  fetchNintendoAccountProfile,
  nintendoAccountId,
  nintendoAccountUserInfo,
  parseNintendoAccountProviderState,
  parseNintendoAccountSessionTokenCode,
  type NintendoAccountProfile,
  type NintendoAccountProviderState,
  type NintendoAccountSessionToken,
  type NintendoAccountToken,
} from "../nintendo-account";

const PROVIDER_LABEL = "Nintendo Switch Parental Controls";

export { NINTENDO_SWITCH_PARENTAL_CONTROLS_APP };

export const NINTENDO_SWITCH_PARENTAL_CONTROLS_AUTHORIZATION_URL =
  NINTENDO_ACCOUNT_AUTHORIZATION_URL;
export const NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN_URL =
  NINTENDO_ACCOUNT_SESSION_TOKEN_URL;
export const NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN_URL =
  NINTENDO_ACCOUNT_TOKEN_URL;
export const NINTENDO_SWITCH_PARENTAL_CONTROLS_PROFILE_URL =
  NINTENDO_ACCOUNT_PROFILE_URL;
export const NINTENDO_SWITCH_PARENTAL_CONTROLS_FEDERATION_URL = `${NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.actionBaseUrl}/v3/actions/federation`;
export const NINTENDO_SWITCH_PARENTAL_CONTROLS_OWNED_DEVICES_URL = `${NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.actionBaseUrl}/v3/actions/user/fetchOwnedDevices`;
export const NINTENDO_SWITCH_PARENTAL_CONTROLS_LOGOUT_URL = `${NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.actionBaseUrl}/v2/actions/logout`;

type NintendoSwitchParentalControlsProviderState = NintendoAccountProviderState;
type NintendoSwitchParentalControlsSessionToken = NintendoAccountSessionToken;
type NintendoSwitchParentalControlsToken = NintendoAccountToken;
type NintendoSwitchParentalControlsProfile = NintendoAccountProfile;

interface NintendoSwitchParentalControlsDeviceCatalogEntry {
  readonly deviceId: string;
  readonly label: string;
}

interface NintendoSwitchParentalControlsDeviceCatalog {
  readonly version: 1;
  readonly devices: readonly NintendoSwitchParentalControlsDeviceCatalogEntry[];
}

const ownedDeviceSchema = z
  .object({
    deviceId: z.string().min(1).max(128),
    label: z.string().max(256),
  })
  .passthrough();

const ownedDevicesSchema = z.array(ownedDeviceSchema).max(100);

const federationResponseSchema = z
  .object({
    loginInfo: z
      .object({
        ownedDevices: ownedDevicesSchema,
      })
      .passthrough(),
  })
  .passthrough();

const fetchOwnedDevicesResponseSchema = z
  .object({
    ownedDevices: ownedDevicesSchema,
  })
  .passthrough();

export function createNintendoSwitchParentalControlsProviderState(): NintendoSwitchParentalControlsProviderState {
  return createNintendoAccountProviderState();
}

export function parseNintendoSwitchParentalControlsProviderState(
  providerState: string,
): NintendoSwitchParentalControlsProviderState {
  return parseNintendoAccountProviderState(providerState);
}

export function buildNintendoSwitchParentalControlsAuthorizationUrl(args: {
  readonly clientId: string;
  readonly grant: ConnectorExternalCodeGrantConfig;
  readonly providerState: NintendoSwitchParentalControlsProviderState;
}): string {
  return buildNintendoAccountAuthorizationUrl({
    ...args,
    redirectUri: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.redirectUri,
  });
}

export function parseNintendoSwitchParentalControlsSessionTokenCode(args: {
  readonly code: string;
  readonly expectedState: string;
}): string {
  return parseNintendoAccountSessionTokenCode({
    ...args,
    providerLabel: PROVIDER_LABEL,
  });
}

export function exchangeNintendoSwitchParentalControlsSessionTokenCode(
  args: {
    readonly clientId: string;
    readonly sessionTokenCode: string;
    readonly codeVerifier: string;
  },
  signal: AbortSignal,
): Promise<NintendoSwitchParentalControlsSessionToken> {
  return exchangeNintendoAccountSessionTokenCode(
    {
      ...args,
      userAgent: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.userAgent,
      providerLabel: PROVIDER_LABEL,
    },
    signal,
  );
}

export function exchangeNintendoSwitchParentalControlsSessionToken(
  args: {
    readonly clientId: string;
    readonly sessionToken: string;
  },
  signal: AbortSignal,
): Promise<NintendoSwitchParentalControlsToken> {
  return exchangeNintendoAccountSessionToken(
    {
      ...args,
      userAgent: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.userAgent,
      providerLabel: PROVIDER_LABEL,
    },
    signal,
  );
}

export function fetchNintendoSwitchParentalControlsProfile(
  args: {
    readonly accessToken: string;
  },
  signal: AbortSignal,
): Promise<NintendoSwitchParentalControlsProfile> {
  return fetchNintendoAccountProfile(
    {
      ...args,
      userAgent: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.userAgent,
      providerLabel: PROVIDER_LABEL,
    },
    signal,
  );
}

export function nintendoSwitchParentalControlsUserInfo(
  idToken: string,
): ConnectorAuthProviderGrantUserInfo {
  return nintendoAccountUserInfo(idToken, PROVIDER_LABEL);
}

export function nintendoSwitchParentalControlsAccountId(
  idToken: string,
): string {
  return nintendoAccountId(idToken, PROVIDER_LABEL);
}

function actionHeaders(args: {
  readonly idToken: string;
  readonly smartDeviceId: string;
  readonly language: string;
  readonly contentType?: "application/json";
}): Record<string, string> {
  return {
    Authorization: `Bearer ${args.idToken}`,
    Accept: "application/json",
    ...(args.contentType === undefined
      ? {}
      : { "Content-Type": args.contentType }),
    "User-Agent": NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.userAgent,
    "X-Moon-App-Id": NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.packageId,
    "X-Moon-Os": NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.os,
    "X-Moon-Os-Version": NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.osVersion,
    "X-Moon-Model": NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.modelName,
    "X-Moon-TimeZone": NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.timeZone,
    "X-Moon-Os-Language": args.language,
    "X-Moon-App-Language": args.language,
    "X-Moon-App-Display-Version":
      NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.displayedVersion,
    "X-Moon-App-Internal-Version": String(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.internalVersion,
    ),
    "X-Moon-Smart-Device-Id": args.smartDeviceId,
  };
}

function serializeDeviceCatalog(
  ownedDevices: z.infer<typeof ownedDevicesSchema>,
): string {
  const catalog: NintendoSwitchParentalControlsDeviceCatalog = {
    version: 1,
    devices: ownedDevices
      .map((ownedDevice) => {
        return {
          deviceId: ownedDevice.deviceId,
          label: ownedDevice.label,
        };
      })
      .sort((left, right) => {
        return left.deviceId.localeCompare(right.deviceId);
      }),
  };
  return JSON.stringify(catalog);
}

export async function federateNintendoSwitchParentalControlsSmartDevice(
  args: {
    readonly idToken: string;
    readonly smartDeviceId: string;
    readonly language: string;
  },
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(
    NINTENDO_SWITCH_PARENTAL_CONTROLS_FEDERATION_URL,
    {
      method: "POST",
      headers: actionHeaders({ ...args, contentType: "application/json" }),
      body: JSON.stringify({
        smartDeviceInfo: {
          id: args.smartDeviceId,
          bundleId: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.packageId,
          os: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.os,
          osVersion: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.osVersion,
          modelName: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.modelName,
          timeZone: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.timeZone,
          appVersion: {
            displayedVersion:
              NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.displayedVersion,
            internalVersion:
              NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.internalVersion,
          },
          osLanguage: args.language,
          appLanguage: args.language,
          notificationToken: null,
        },
      }),
      signal,
    },
  );

  if (!response.ok) {
    await throwOAuthError(PROVIDER_LABEL, "smart-device federation", response);
  }

  const raw = federationResponseSchema.parse(await response.json());
  return serializeDeviceCatalog(raw.loginInfo.ownedDevices);
}

export async function fetchNintendoSwitchParentalControlsDeviceCatalog(
  args: {
    readonly idToken: string;
    readonly smartDeviceId: string;
    readonly language: string;
  },
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(
    NINTENDO_SWITCH_PARENTAL_CONTROLS_OWNED_DEVICES_URL,
    {
      headers: actionHeaders(args),
      signal,
    },
  );

  if (!response.ok) {
    await throwOAuthError(PROVIDER_LABEL, "device catalog", response);
  }

  const raw = fetchOwnedDevicesResponseSchema.parse(await response.json());
  return serializeDeviceCatalog(raw.ownedDevices);
}

export async function logoutNintendoSwitchParentalControlsSmartDevice(
  args: {
    readonly idToken: string;
    readonly smartDeviceId: string;
    readonly language: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(NINTENDO_SWITCH_PARENTAL_CONTROLS_LOGOUT_URL, {
    method: "POST",
    headers: actionHeaders({ ...args, contentType: "application/json" }),
    body: JSON.stringify({ smartDeviceId: args.smartDeviceId }),
    signal,
  });

  if (!response.ok) {
    await throwOAuthError(PROVIDER_LABEL, "smart-device logout", response);
  }
}
