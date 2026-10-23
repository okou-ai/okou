import * as z from "zod";

import { safeJsonParse, safeSync } from "../utils";

/**
 * Server-side parser for the contents of `~/.codex/auth.json` produced by
 * `codex login`. Validates shape via zod, decodes the access_token + id_token
 * JWTs to derive `tokenExpiresAt`, `accountId`, `planType`, and
 * `workspaceName`, and rejects free-plan accounts with a typed error.
 *
 * The raw `CODEX_AUTH_JSON` blob this parser consumes is NEVER persisted —
 * the route handler discards it after parsing and only the four derived
 * `CHATGPT_*` fields are stored as secrets (per #7365 / Epic #11974).
 *
 * API-authoritative parser for model-provider auth_json paste routes.
 */

// JWT payload decode without signature verification: the access_token and
// id_token are validated cryptographically by the upstream ChatGPT backend
// and the user's TLS-secured `codex login` flow. Codex CLI itself does not
// verify locally either.
function decodeJwtPayload(token: string): unknown {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    throw new Error("Invalid JWT structure");
  }
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const json = Buffer.from(padded + padding, "base64").toString("utf8");
  const parsed = safeJsonParse(json);
  if (parsed === undefined) {
    throw new Error("Invalid JWT payload JSON");
  }
  return parsed;
}

const chatgptNamedClaimSchema = z
  .object({
    title: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    display_name: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  })
  .passthrough();

const chatgptAuthClaimsSchema = z
  .object({
    chatgpt_account_id: z.string().optional(),
    chatgpt_plan_type: z.string().optional(),
    organization: chatgptNamedClaimSchema.nullable().optional(),
    workspace: chatgptNamedClaimSchema.nullable().optional(),
    account: chatgptNamedClaimSchema.nullable().optional(),
    chatgpt_workspace_name: z.string().nullable().optional(),
    chatgpt_workspace_title: z.string().nullable().optional(),
    chatgpt_workspace_display_name: z.string().nullable().optional(),
    chatgpt_organization_name: z.string().nullable().optional(),
    chatgpt_account_name: z.string().nullable().optional(),
    organization_name: z.string().nullable().optional(),
    workspace_name: z.string().nullable().optional(),
  })
  .passthrough();

const chatgptIdTokenClaimsSchema = z
  .object({
    exp: z.number().optional(),
    email: z.string().nullable().optional(),
    "https://api.openai.com/profile.email": z.string().nullable().optional(),
    "https://api.openai.com/auth": chatgptAuthClaimsSchema.optional(),
  })
  .passthrough();

type ChatgptAuthClaims = z.infer<typeof chatgptAuthClaimsSchema>;
type ChatgptNamedClaim = z.infer<typeof chatgptNamedClaimSchema>;

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function extractNamedClaim(claim: ChatgptNamedClaim | null | undefined) {
  if (!claim) {
    return null;
  }
  return (
    nonEmptyString(claim.title) ??
    nonEmptyString(claim.name) ??
    nonEmptyString(claim.display_name) ??
    nonEmptyString(claim.displayName) ??
    null
  );
}

function extractWorkspaceName(authClaims: ChatgptAuthClaims): string | null {
  return (
    extractNamedClaim(authClaims.organization) ??
    extractNamedClaim(authClaims.workspace) ??
    nonEmptyString(authClaims.chatgpt_workspace_name) ??
    nonEmptyString(authClaims.chatgpt_workspace_title) ??
    nonEmptyString(authClaims.chatgpt_workspace_display_name) ??
    nonEmptyString(authClaims.chatgpt_organization_name) ??
    nonEmptyString(authClaims.organization_name) ??
    nonEmptyString(authClaims.workspace_name) ??
    extractNamedClaim(authClaims.account) ??
    nonEmptyString(authClaims.chatgpt_account_name) ??
    null
  );
}

export function extractCodexAccountEmailFromIdToken(
  idToken: string | null | undefined,
): string | null {
  if (!idToken) {
    return null;
  }
  const decoded = safeSync(() => {
    return chatgptIdTokenClaimsSchema.parse(decodeJwtPayload(idToken));
  });
  if ("error" in decoded) {
    return null;
  }
  return (
    nonEmptyString(decoded.ok.email) ??
    nonEmptyString(decoded.ok["https://api.openai.com/profile.email"]) ??
    null
  );
}

const MAX_AUTH_JSON_BYTES = 16 * 1024;

const codexAuthJsonSchema = z
  .object({
    tokens: z.object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1),
      account_id: z.string().min(1),
      id_token: z.string().min(1),
    }),
  })
  .passthrough();

const expSchema = z.object({ exp: z.number() }).passthrough();

/**
 * Typed error thrown when the pasted auth.json is malformed JSON, fails the
 * shape schema, or omits required claims. Matches the project pattern
 * (Error with `name`-tagged narrowing) from `codex-oauth.ts`. Not exported —
 * callers narrow via the `isCodexAuthJsonShapeError` type guard.
 */
interface CodexAuthJsonShapeError extends Error {
  readonly name: "CodexAuthJsonShapeError";
}

interface CodexAuthJsonFreePlanError extends Error {
  readonly name: "CodexAuthJsonFreePlanError";
}

function createCodexAuthJsonShapeError(
  message: string,
): CodexAuthJsonShapeError {
  const err = new Error(message);
  err.name = "CodexAuthJsonShapeError";
  return err as CodexAuthJsonShapeError;
}

function createCodexAuthJsonFreePlanError(): CodexAuthJsonFreePlanError {
  const err = new Error(
    "ChatGPT free plan is not supported — upgrade to Plus, Pro, Business, Edu, or Enterprise",
  );
  err.name = "CodexAuthJsonFreePlanError";
  return err as CodexAuthJsonFreePlanError;
}

export function isCodexAuthJsonShapeError(
  v: unknown,
): v is CodexAuthJsonShapeError {
  return v instanceof Error && v.name === "CodexAuthJsonShapeError";
}

export function isCodexAuthJsonFreePlanError(
  v: unknown,
): v is CodexAuthJsonFreePlanError {
  return v instanceof Error && v.name === "CodexAuthJsonFreePlanError";
}

interface ParsedCodexAuth {
  accessToken: string;
  refreshToken: string;
  /**
   * Always sourced from `id_token`'s `chatgpt_account_id` claim — NOT from the
   * plain `tokens.account_id` field. The id_token claim is cryptographically
   * tied to the upstream session; the plain JSON field is informational.
   */
  accountId: string;
  idToken: string;
  tokenExpiresAt: Date;
  workspaceName: string | null;
  planType: string;
}

function readJwtExp(token: string): number | null {
  const decoded = safeSync(() => {
    return decodeJwtPayload(token);
  });
  if ("error" in decoded) {
    return null;
  }
  const parsed = expSchema.safeParse(decoded.ok);
  return parsed.success ? parsed.data.exp : null;
}

export function parseCodexAuthJson(raw: string): ParsedCodexAuth {
  if (raw.length > MAX_AUTH_JSON_BYTES) {
    throw createCodexAuthJsonShapeError(
      "auth.json is unexpectedly large — paste only the contents of ~/.codex/auth.json",
    );
  }

  const parsed = safeJsonParse(raw);
  if (parsed === undefined) {
    throw createCodexAuthJsonShapeError("auth.json is not valid JSON");
  }

  const shape = codexAuthJsonSchema.safeParse(parsed);
  if (!shape.success) {
    throw createCodexAuthJsonShapeError(
      "auth.json shape unrecognized — your codex CLI may need updating",
    );
  }
  const { tokens } = shape.data;

  // Decode id_token first — its claims drive both account_id (cryptographically
  // signed source of truth) and the plan-type rejection. Match the OAuth
  // callback's ordering: shape errors win over free-plan errors.
  const idClaimsResult = safeSync(() => {
    return chatgptIdTokenClaimsSchema.parse(decodeJwtPayload(tokens.id_token));
  });
  if ("error" in idClaimsResult) {
    throw createCodexAuthJsonShapeError("auth.json id_token claims unparsable");
  }
  const idClaims = idClaimsResult.ok;
  const auth = idClaims["https://api.openai.com/auth"];
  if (!auth?.chatgpt_account_id || !auth.chatgpt_plan_type) {
    throw createCodexAuthJsonShapeError(
      "auth.json id_token missing required claims",
    );
  }
  if (auth.chatgpt_plan_type === "free") {
    throw createCodexAuthJsonFreePlanError();
  }

  // tokenExpiresAt: prefer access_token.exp (the artifact that actually expires
  // for inference), fall back to id_token.exp if the access_token is opaque.
  const tokenExp = readJwtExp(tokens.access_token) ?? idClaims.exp ?? null;
  if (tokenExp === null) {
    throw createCodexAuthJsonShapeError(
      "auth.json access_token has no exp claim",
    );
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: auth.chatgpt_account_id,
    idToken: tokens.id_token,
    tokenExpiresAt: new Date(tokenExp * 1000),
    workspaceName: extractWorkspaceName(auth),
    planType: auth.chatgpt_plan_type,
  };
}
