import { createHmac, hkdfSync } from "node:crypto";

import {
  CAPABILITIES,
  Capability,
} from "@okouai/api-contracts/contracts/capabilities";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { SKILL_IMPORT_SESSION_TTL_SECONDS } from "@okouai/api-contracts/contracts/skill-import-session";
import {
  workflowImportSourceSchema,
  type WorkflowImportSource,
} from "@okouai/api-contracts/contracts/workflow-import-source";
import {
  array,
  literal,
  number,
  object,
  record,
  string,
  uuid,
  type input,
  type infer as zInfer,
} from "zod";

import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { safeJsonParse } from "../utils";
import {
  AgentAuth,
  CliAuth,
  ComposeJobAuth,
  SandboxAuth,
  SkillImportAuth,
} from "../../types/auth";
import { singleton } from "../../lib/singleton";

const SANDBOX_TOKEN_PREFIX = "vm0_sandbox_";
const PAT_TOKEN_PREFIX = "vm0_pat_";
// Skill import sessions carry their own prefix so the upload handler is the
// only code that can accept them. They are never registered as a general auth
// token type, so no other route can be reached with one.
const SKILL_IMPORT_TOKEN_PREFIX = "vm0_skillimport_v2_";
// Covers the runner's two-hour execution budget plus claim, startup,
// finalization, and terminal report time.
const SANDBOX_TOKEN_TTL_SECONDS = 3 * 60 * 60;

const CONDITIONAL_CAPABILITIES = [
  ["computer-use:shell:write", FeatureSwitchKey.DesktopShell],
  ["suggestion:read", FeatureSwitchKey.AgentSuggestion],
  ["suggestion:write", FeatureSwitchKey.AgentSuggestion],
  ["job:read", FeatureSwitchKey.ProactiveAgent],
  ["job:write", FeatureSwitchKey.ProactiveAgent],
  ["banking:read", FeatureSwitchKey.Banking],
  ["lark:write", FeatureSwitchKey.LarkIntegration],
  ["wechat:read", FeatureSwitchKey.WechatIntegration],
  ["wechat:write", FeatureSwitchKey.WechatIntegration],
  ["whatsapp:write", FeatureSwitchKey.WhatsappIntegration],
  ["whatsapp:file:write", FeatureSwitchKey.WhatsappFileUpload],
  ["presentation-convert:write", FeatureSwitchKey.PresentationConvert],
] as const satisfies readonly (readonly [Capability, FeatureSwitchKey])[];

const AGENT_EXCLUDED_CAPABILITIES = [
  "agent:delete",
] as const satisfies readonly Capability[];

interface OkouTokenOptions {
  readonly isDefaultAgent?: boolean;
  readonly computerUseHostId?: string;
  readonly cloudBrowserEnabled?: boolean;
  readonly customConnectorSourceIds?: Readonly<Record<string, string>>;
  readonly builtinConnectorSourceIds?: Readonly<Record<string, string>>;
}

const jwtBaseSchema = object({
  userId: string().min(1),
  scope: string(),
  iat: number(),
  exp: number(),
});

const sandboxTokenPayloadSchema = jwtBaseSchema.extend({
  scope: literal("sandbox"),
  runId: string().min(1),
  orgId: string().min(1),
});

function isAgentCapability(value: string): value is Capability {
  return CAPABILITIES.some((capability) => {
    return capability === value;
  });
}

// Capability names are open-ended at the token boundary so tokens issued by a
// newer API remain valid on an older API. The validated output remains closed
// to known capabilities so unknown names cannot grant permissions.
const agentCapabilitiesSchema = array(string().min(1))
  .transform((capabilities) => {
    return capabilities.filter(isAgentCapability);
  })
  .readonly();

const okouTokenPayloadSchema = jwtBaseSchema.extend({
  scope: literal("okou"),
  runId: string().min(1),
  orgId: string().min(1),
  capabilities: agentCapabilitiesSchema,
  computerUseHostId: uuid().optional(),
  cloudBrowserEnabled: literal(true).optional(),
  customConnectorSourceIds: record(uuid(), uuid()).optional(),
  builtinConnectorSourceIds: record(connectorSlugSchema, uuid()).optional(),
});

type OkouTokenClaims = Omit<zInfer<typeof okouTokenPayloadSchema>, "scope">;

const cliTokenPayloadSchema = jwtBaseSchema.extend({
  scope: literal("cli"),
  orgId: string().min(1),
  tokenId: string().min(1),
});

const composeJobTokenPayloadSchema = jwtBaseSchema.extend({
  scope: literal("compose-job"),
  jobId: string().min(1),
});

const skillImportTokenPayloadSchema = jwtBaseSchema.extend({
  scope: literal("skill-import"),
  orgId: string().min(1),
  agentId: string().min(1),
  provider: workflowImportSourceSchema,
  sessionId: uuid(),
});

export type SkillImportTokenPayload = zInfer<
  typeof skillImportTokenPayloadSchema
>;

type JwtPayloadInput =
  | input<typeof sandboxTokenPayloadSchema>
  | input<typeof okouTokenPayloadSchema>
  | input<typeof cliTokenPayloadSchema>
  | input<typeof composeJobTokenPayloadSchema>
  | input<typeof skillImportTokenPayloadSchema>;

function base64UrlEncode(data: Buffer | string): string {
  const buffer = typeof data === "string" ? Buffer.from(data) : data;
  return buffer.toString("base64url");
}

function base64UrlDecode(data: string): Buffer {
  return Buffer.from(data, "base64url");
}

function deriveJwtKey(): Buffer {
  const masterKey = Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex");
  return Buffer.from(
    hkdfSync("sha256", masterKey, "", "jwt-sandbox-signing", 32),
  );
}

function featureSwitchForCapability(
  capabilitySwitches: readonly (readonly [Capability, FeatureSwitchKey])[],
  capability: Capability,
): FeatureSwitchKey | undefined {
  return capabilitySwitches.find(([entryCapability]) => {
    return entryCapability === capability;
  })?.[1];
}

/**
 * Answers whether a feature switch is enabled for the token's user. The
 * caller evaluates switches; this module only maps capabilities to keys.
 */
type FeatureEnabled = (key: FeatureSwitchKey) => boolean;

function isAgentCapabilityEnabled(
  capability: Capability,
  featureEnabled: FeatureEnabled,
): boolean {
  const featureSwitch = featureSwitchForCapability(
    CONDITIONAL_CAPABILITIES,
    capability,
  );
  if (featureSwitch === undefined) {
    return true;
  }

  return featureEnabled(featureSwitch);
}

function isCapabilityAvailableToAgent(
  capability: Capability,
  options: OkouTokenOptions | undefined,
): boolean {
  if (
    capability === "suggestion:read" ||
    capability === "suggestion:write" ||
    capability === "job:read" ||
    capability === "job:write"
  ) {
    return options?.isDefaultAgent === true;
  }
  if (
    AGENT_EXCLUDED_CAPABILITIES.some((excludedCapability) => {
      return excludedCapability === capability;
    })
  ) {
    return false;
  }
  if (
    capability === "computer-use:write" ||
    capability === "computer-use:shell:write"
  ) {
    return options?.computerUseHostId !== undefined;
  }
  if (capability === "browser:read" || capability === "browser:write") {
    return options?.cloudBrowserEnabled === true;
  }
  return true;
}

const getJwtKey = singleton((): Buffer => {
  return deriveJwtKey();
});

function signJwt(payload: JwtPayloadInput): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerEncoded = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
  const data = `${headerEncoded}.${payloadEncoded}`;
  const signature = createHmac("sha256", getJwtKey()).update(data).digest();
  return `${data}.${base64UrlEncode(signature)}`;
}

function verifyJwtPayload(rawJwt: string): unknown {
  const parts = rawJwt.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
  if (!headerEncoded || !payloadEncoded || !signatureEncoded) {
    return null;
  }

  const data = `${headerEncoded}.${payloadEncoded}`;
  const expectedSignature = createHmac("sha256", getJwtKey())
    .update(data)
    .digest();
  const actualSignature = base64UrlDecode(signatureEncoded);

  if (
    expectedSignature.length !== actualSignature.length ||
    !expectedSignature.equals(actualSignature)
  ) {
    return null;
  }

  const parsed = safeJsonParse(base64UrlDecode(payloadEncoded).toString());
  if (parsed === undefined) {
    return null;
  }

  const base = jwtBaseSchema.safeParse(parsed);
  if (!base.success || base.data.exp < Math.floor(now() / 1000)) {
    return null;
  }
  return parsed;
}

function verifyPrefixedToken(token: string, prefix: string): unknown {
  if (!token.startsWith(prefix)) {
    return null;
  }

  return verifyJwtPayload(token.slice(prefix.length));
}

export function isSandboxToken(token: string): boolean {
  return token.startsWith(SANDBOX_TOKEN_PREFIX);
}

export function isPatToken(token: string): boolean {
  return token.startsWith(PAT_TOKEN_PREFIX);
}

export function verifySandboxToken(token: string): SandboxAuth | null {
  const parsed = sandboxTokenPayloadSchema.safeParse(
    verifyPrefixedToken(token, SANDBOX_TOKEN_PREFIX),
  );

  if (!parsed.success) {
    return null;
  }

  return {
    userId: parsed.data.userId,
    runId: parsed.data.runId,
    orgId: parsed.data.orgId,
  };
}

export function verifyOkouToken(token: string): AgentAuth | null {
  const parsed = okouTokenPayloadSchema.safeParse(
    verifyPrefixedToken(token, SANDBOX_TOKEN_PREFIX),
  );

  if (!parsed.success) {
    return null;
  }

  return {
    userId: parsed.data.userId,
    runId: parsed.data.runId,
    orgId: parsed.data.orgId,
    capabilities: parsed.data.capabilities,
    ...(parsed.data.computerUseHostId
      ? { computerUseHostId: parsed.data.computerUseHostId }
      : {}),
    ...(parsed.data.cloudBrowserEnabled
      ? { cloudBrowserEnabled: parsed.data.cloudBrowserEnabled }
      : {}),
    ...(parsed.data.customConnectorSourceIds
      ? { customConnectorSourceIds: parsed.data.customConnectorSourceIds }
      : {}),
    ...(parsed.data.builtinConnectorSourceIds
      ? { builtinConnectorSourceIds: parsed.data.builtinConnectorSourceIds }
      : {}),
  };
}

export function verifyComposeJobToken(token: string): ComposeJobAuth | null {
  const parsed = composeJobTokenPayloadSchema.safeParse(
    verifyPrefixedToken(token, SANDBOX_TOKEN_PREFIX),
  );

  if (!parsed.success) {
    return null;
  }

  return {
    userId: parsed.data.userId,
    jobId: parsed.data.jobId,
  };
}

export function verifyCliToken(token: string): CliAuth | null {
  const parsed = cliTokenPayloadSchema.safeParse(
    verifyPrefixedToken(token, PAT_TOKEN_PREFIX),
  );

  if (!parsed.success) {
    return null;
  }

  return {
    userId: parsed.data.userId,
    orgId: parsed.data.orgId,
    tokenId: parsed.data.tokenId,
  };
}

export function generateSandboxToken(
  userId: string,
  runId: string,
  orgId: string,
): string {
  const nowSeconds = Math.floor(now() / 1000);
  const payload: zInfer<typeof sandboxTokenPayloadSchema> = {
    scope: "sandbox",
    userId,
    runId,
    orgId,
    iat: nowSeconds,
    exp: nowSeconds + SANDBOX_TOKEN_TTL_SECONDS,
  };

  return SANDBOX_TOKEN_PREFIX + signJwt(payload);
}

export function generateOkouToken(
  userId: string,
  runId: string,
  orgId: string,
  featureEnabled: FeatureEnabled,
  options?: OkouTokenOptions,
): string {
  return signOkouToken(
    buildOkouTokenClaims(userId, runId, orgId, featureEnabled, options),
  );
}

function buildOkouTokenClaims(
  userId: string,
  runId: string,
  orgId: string,
  featureEnabled: FeatureEnabled,
  options: OkouTokenOptions | undefined,
): OkouTokenClaims {
  const nowSeconds = Math.floor(now() / 1000);
  const capabilities: Capability[] = [];
  for (const capability of CAPABILITIES) {
    if (!isCapabilityAvailableToAgent(capability, options)) {
      continue;
    }
    if (isAgentCapabilityEnabled(capability, featureEnabled)) {
      capabilities.push(capability);
    }
  }
  return {
    userId,
    runId,
    orgId,
    capabilities,
    ...(capabilities.includes("computer-use:write") &&
    options?.computerUseHostId
      ? { computerUseHostId: options.computerUseHostId }
      : {}),
    ...(capabilities.includes("browser:write") &&
    options?.cloudBrowserEnabled === true
      ? { cloudBrowserEnabled: true as const }
      : {}),
    ...(options?.customConnectorSourceIds
      ? { customConnectorSourceIds: options.customConnectorSourceIds }
      : {}),
    ...(options?.builtinConnectorSourceIds
      ? { builtinConnectorSourceIds: options.builtinConnectorSourceIds }
      : {}),
    iat: nowSeconds,
    exp: nowSeconds + 2 * 60 * 60,
  };
}

function signOkouToken(claims: OkouTokenClaims): string {
  const payload: zInfer<typeof okouTokenPayloadSchema> = {
    scope: "okou",
    ...claims,
  };
  return SANDBOX_TOKEN_PREFIX + signJwt(payload);
}

export function verifySkillImportToken(token: string): SkillImportAuth | null {
  const parsed = skillImportTokenPayloadSchema.safeParse(
    verifyPrefixedToken(token, SKILL_IMPORT_TOKEN_PREFIX),
  );

  if (!parsed.success) {
    return null;
  }

  return {
    userId: parsed.data.userId,
    orgId: parsed.data.orgId,
    agentId: parsed.data.agentId,
    provider: parsed.data.provider,
    sessionId: parsed.data.sessionId,
  };
}

export function generateSkillImportToken(
  userId: string,
  orgId: string,
  agentId: string,
  provider: WorkflowImportSource,
  sessionId: string,
): { readonly token: string; readonly expiresAt: Date } {
  const nowSeconds = Math.floor(now() / 1000);
  const expiresAtSeconds = nowSeconds + SKILL_IMPORT_SESSION_TTL_SECONDS;
  const payload: zInfer<typeof skillImportTokenPayloadSchema> = {
    scope: "skill-import",
    userId,
    orgId,
    agentId,
    provider,
    sessionId,
    iat: nowSeconds,
    exp: expiresAtSeconds,
  };

  return {
    token: SKILL_IMPORT_TOKEN_PREFIX + signJwt(payload),
    expiresAt: new Date(expiresAtSeconds * 1000),
  };
}

export function generateCliToken(
  userId: string,
  orgId: string,
  tokenId: string,
): string {
  const nowSeconds = Math.floor(now() / 1000);
  const payload: zInfer<typeof cliTokenPayloadSchema> = {
    scope: "cli",
    userId,
    orgId,
    tokenId,
    iat: nowSeconds,
    exp: nowSeconds + 90 * 24 * 60 * 60,
  };

  return PAT_TOKEN_PREFIX + signJwt(payload);
}

export function signSandboxJwtForTests(payload: JwtPayloadInput): string {
  return SANDBOX_TOKEN_PREFIX + signJwt(payload);
}

export function signPatJwtForTests(
  payload: zInfer<typeof cliTokenPayloadSchema>,
): string {
  return PAT_TOKEN_PREFIX + signJwt(payload);
}

export function signSkillImportJwtForTests(
  payload: SkillImportTokenPayload,
): string {
  return SKILL_IMPORT_TOKEN_PREFIX + signJwt(payload);
}
