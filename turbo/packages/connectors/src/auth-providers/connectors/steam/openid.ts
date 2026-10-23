import * as z from "zod";

const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const STEAM_OPENID_NS = "http://specs.openid.net/auth/2.0";
const STEAM_OPENID_IDENTIFIER_SELECT =
  "http://specs.openid.net/auth/2.0/identifier_select";
const STEAM_CLAIMED_ID_PATTERN =
  /^https?:\/\/steamcommunity\.com\/openid\/id\/(?<steamId>\d{17})$/u;
const REQUIRED_SIGNED_OPENID_FIELDS = [
  "op_endpoint",
  "return_to",
  "response_nonce",
  "assoc_handle",
  "claimed_id",
  "identity",
] as const;

const steamOpenIdVerificationResponseSchema = z.object({
  ns: z.string().optional(),
  is_valid: z.enum(["true", "false"]).optional(),
});

interface SteamOpenIdVerificationResult {
  readonly steamId: string;
}

export function buildSteamOpenIdAuthorizationUrl(args: {
  readonly returnTo: string;
  readonly realm: string;
}): string {
  const params = new URLSearchParams({
    "openid.ns": STEAM_OPENID_NS,
    "openid.mode": "checkid_setup",
    "openid.return_to": args.returnTo,
    "openid.realm": args.realm,
    "openid.identity": STEAM_OPENID_IDENTIFIER_SELECT,
    "openid.claimed_id": STEAM_OPENID_IDENTIFIER_SELECT,
  });

  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

function requiredOpenIdParam(
  params: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = params[name];
  if (!value) {
    throw new Error(`Steam OpenID callback missing ${name}`);
  }
  return value;
}

function parseSteamClaimedId(value: string): string {
  const match = STEAM_CLAIMED_ID_PATTERN.exec(value);
  const steamId = match?.groups?.steamId;
  if (!steamId) {
    throw new Error("Steam OpenID callback contained an invalid claimed ID");
  }
  return steamId;
}

function validateSignedFields(params: Readonly<Record<string, string>>): void {
  requiredOpenIdParam(params, "openid.sig");
  const signedFields = new Set(
    requiredOpenIdParam(params, "openid.signed")
      .split(",")
      .map((field) => {
        return field.trim();
      }),
  );

  for (const field of REQUIRED_SIGNED_OPENID_FIELDS) {
    if (!signedFields.has(field)) {
      throw new Error("Steam OpenID callback did not sign required fields");
    }
  }
}

function validateSteamOpenIdCallback(args: {
  readonly params: Readonly<Record<string, string>>;
  readonly expectedReturnTo: string;
  readonly expectedRealm: string;
}): string {
  if (requiredOpenIdParam(args.params, "openid.mode") !== "id_res") {
    throw new Error("Steam OpenID callback did not contain an assertion");
  }
  if (requiredOpenIdParam(args.params, "openid.ns") !== STEAM_OPENID_NS) {
    throw new Error("Steam OpenID callback used an unexpected namespace");
  }
  if (
    requiredOpenIdParam(args.params, "openid.op_endpoint") !==
    STEAM_OPENID_ENDPOINT
  ) {
    throw new Error("Steam OpenID callback used an unexpected endpoint");
  }
  if (
    requiredOpenIdParam(args.params, "openid.return_to") !==
    args.expectedReturnTo
  ) {
    throw new Error("Steam OpenID callback used an unexpected return URL");
  }

  const callbackRealm = args.params["openid.realm"];
  if (callbackRealm && callbackRealm !== args.expectedRealm) {
    throw new Error("Steam OpenID callback used an unexpected realm");
  }
  validateSignedFields(args.params);

  const claimedSteamId = parseSteamClaimedId(
    requiredOpenIdParam(args.params, "openid.claimed_id"),
  );
  const identitySteamId = parseSteamClaimedId(
    requiredOpenIdParam(args.params, "openid.identity"),
  );
  if (claimedSteamId !== identitySteamId) {
    throw new Error("Steam OpenID callback identity did not match claimed ID");
  }
  return claimedSteamId;
}

function parseSteamOpenIdVerificationResponse(
  body: string,
): Record<string, string> {
  return Object.fromEntries(
    body.split(/\r?\n/u).flatMap((line) => {
      const separator = line.indexOf(":");
      if (separator === -1) {
        return [];
      }
      return [[line.slice(0, separator), line.slice(separator + 1)]] as const;
    }),
  );
}

export async function verifySteamOpenIdCallback(
  args: {
    readonly callbackParams: Readonly<Record<string, string>>;
    readonly expectedReturnTo: string;
    readonly expectedRealm: string;
  },
  signal: AbortSignal,
): Promise<SteamOpenIdVerificationResult> {
  const steamId = validateSteamOpenIdCallback({
    params: args.callbackParams,
    expectedReturnTo: args.expectedReturnTo,
    expectedRealm: args.expectedRealm,
  });

  const body = new URLSearchParams(
    Object.entries(args.callbackParams).filter(([name]) => {
      return name.startsWith("openid.");
    }),
  );
  body.set("openid.mode", "check_authentication");

  const response = await fetch(STEAM_OPENID_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/plain",
    },
    body,
    signal,
  });
  if (!response.ok) {
    throw new Error(`Steam OpenID verification failed: ${response.status}`);
  }

  const parsed = steamOpenIdVerificationResponseSchema.parse(
    parseSteamOpenIdVerificationResponse(await response.text()),
  );
  if (parsed.ns && parsed.ns !== STEAM_OPENID_NS) {
    throw new Error("Steam OpenID verification used an unexpected namespace");
  }
  if (parsed.is_valid !== "true") {
    throw new Error("Steam OpenID assertion was not valid");
  }

  return { steamId };
}
