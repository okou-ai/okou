import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { command } from "ccstate";
import { billingRedeemCodeContract } from "@okouai/api-contracts/contracts/billing";

import { optionalEnv } from "../../lib/env";
import { badRequestMessage, providerUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import type { RouteEntry } from "../route-entry";
import { safeJsonParse, settle } from "../utils";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can manage billing",
      code: "FORBIDDEN",
    }),
  }),
});

const ATOM_M2M_TOKEN_TTL_SECONDS = 60 * 60;
const ATOM_M2M_TOKEN_MIN_REMAINING_TTL_SECONDS = 5 * 60;
const DEFAULT_REDEEM_CODE_ERROR_MESSAGE = "Redeem code could not be redeemed";

const ATOM_REDEEM_CODE_ERROR_MESSAGES: Readonly<Record<string, string>> =
  Object.freeze({
    already_redeemed: "This redeem code has already been used",
    already_used: "This redeem code has already been used",
    code_already_redeemed: "This redeem code has already been used",
    code_already_used: "This redeem code has already been used",
    code_expired: "This redeem code has expired",
    code_invalid: "Invalid redeem code",
    code_not_found: "Invalid redeem code",
    expired: "This redeem code has expired",
    invalid: "Invalid redeem code",
    invalid_code: "Invalid redeem code",
    not_eligible: "This code is not eligible for this workspace",
    not_found: "Invalid redeem code",
    org_mismatch: "This code is not eligible for this workspace",
    redeemed: "This redeem code has already been used",
    wrong_org: "This code is not eligible for this workspace",
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringProperty(
  value: unknown,
  property: string,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const propertyValue = value[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function normalizeAtomErrorCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, "_");
}

function atomRedeemErrorCode(body: unknown): string | undefined {
  const directCode =
    getStringProperty(body, "code") ?? getStringProperty(body, "error_code");
  if (directCode) {
    return directCode;
  }

  if (!isRecord(body)) {
    return undefined;
  }

  const error = body.error;
  if (typeof error === "string") {
    return error;
  }

  return (
    getStringProperty(error, "code") ??
    getStringProperty(error, "error_code") ??
    getStringProperty(error, "type") ??
    getStringProperty(error, "message")
  );
}

function atomRedeemFallbackMessage(status: number): string {
  switch (status) {
    case 403: {
      return "This code is not eligible for this workspace";
    }
    case 404: {
      return "Invalid redeem code";
    }
    case 409: {
      return "This redeem code has already been used";
    }
    case 410: {
      return "This redeem code has expired";
    }
    default: {
      return DEFAULT_REDEEM_CODE_ERROR_MESSAGE;
    }
  }
}

async function atomRedeemErrorMessage(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    const responseText = await settle(response.text(), signal);
    signal.throwIfAborted();
    if (!responseText.ok) {
      return atomRedeemFallbackMessage(response.status);
    }
    const body = safeJsonParse(responseText.value);
    if (body !== undefined) {
      const code = atomRedeemErrorCode(body);
      if (code) {
        const message =
          ATOM_REDEEM_CODE_ERROR_MESSAGES[normalizeAtomErrorCode(code)];
        if (message) {
          return message;
        }
      }
    }
  }

  return atomRedeemFallbackMessage(response.status);
}

async function primaryEmailForUser(
  clerk: ReturnType<typeof clerk$.read>,
  userId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const user = await findClerkUser(clerk, userId, signal);
  signal.throwIfAborted();
  if (!user) {
    return undefined;
  }

  return (
    user.emailAddresses.find((emailAddress) => {
      return emailAddress.id === user.primaryEmailAddressId;
    })?.emailAddress ?? user.emailAddresses[0]?.emailAddress
  );
}

const redeemCodeAuthed$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  signal.throwIfAborted();

  const bodyResult = await get(bodyResultOf(billingRedeemCodeContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const atomUrl = optionalEnv("ATOM_URL");
  if (!atomUrl) {
    return providerUnavailable("Redeem service not configured");
  }

  const clerk = get(clerk$);
  const emailResult = await settle(
    primaryEmailForUser(clerk, auth.userId, signal),
    signal,
  );
  signal.throwIfAborted();
  if (!emailResult.ok || !emailResult.value) {
    return providerUnavailable("Redeem service user unavailable");
  }
  const email = emailResult.value;

  const machineSecretKey = optionalEnv("OKOU_MACHINE_SECRET_KEY");
  if (!machineSecretKey) {
    return providerUnavailable("Redeem service not configured");
  }

  const tokenResult = await settle(
    clerk.m2m.createToken({
      machineSecretKey,
      secondsUntilExpiration: ATOM_M2M_TOKEN_TTL_SECONDS,
      minRemainingTtlSeconds: ATOM_M2M_TOKEN_MIN_REMAINING_TTL_SECONDS,
    }),
    signal,
  );
  signal.throwIfAborted();
  if (!tokenResult.ok || !tokenResult.value.token) {
    return providerUnavailable("Redeem service authentication unavailable");
  }
  const m2mToken = tokenResult.value;

  const url = new URL("/api/redeem-codes/consume", atomUrl);

  const result = await settle(
    accept(
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${m2mToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code: bodyResult.data.code,
          email,
          org_id: auth.orgId,
          user_id: auth.userId,
        }),
        signal,
      }),
      [200],
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    if (
      result.error instanceof HttpStatusError &&
      result.error.status >= 400 &&
      result.error.status < 500
    ) {
      return badRequestMessage(
        await atomRedeemErrorMessage(result.error.response, signal),
      );
    }
    return providerUnavailable("Redeem service unavailable");
  }

  return {
    status: 200 as const,
    body: { redeemed: true as const },
  };
});

const redeemCode$ = authRoute(
  { requireOrganization: true, missingOrganizationStatus: 401 },
  redeemCodeAuthed$,
);

export const billingRedeemCodeRoutes: readonly RouteEntry[] = [
  {
    route: billingRedeemCodeContract.create,
    handler: redeemCode$,
  },
];
