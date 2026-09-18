import { createHmac, hkdfSync } from "node:crypto";

import {
  CAPABILITIES,
  Capability,
} from "@okouai/api-contracts/contracts/capabilities";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { z } from "zod";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { safeJsonParse } from "../utils";
import {
  AgentAuth,
  CliAuth,
  ComposeJobAuth,
  SandboxAuth,
} from "../../types/auth";
import { singleton } from "../../lib/singleton";

const SANDBOX_TOKEN_PREFIX = "vm0_sandbox_";
const PAT_TOKEN_PREFIX = "vm0_pat_";
// Covers the runner's two-hour execution budget plus claim, startup,
// finalization, and terminal report time.
const SANDBOX_TOKEN_TTL_SECONDS = 3 * 60 * 60;

const CONDITIONAL_CAPABILITIES = [
  ["artifact:read", FeatureSwitchKey.PrivateArtifacts],
  ["artifact:write", FeatureSwitchKey.PrivateArtifacts],
  ["banking:read", FeatureSwitchKey.Banking],
  ["lark:write", FeatureSwitchKey.LarkIntegration],
  ["user-template:write", FeatureSwitchKey.CustomTemplates],
  ["vnc:read", FeatureSwitchKey.VncAccess],
  ["vnc:write", FeatureSwitchKey.VncAccess],
] as const satisfies readonly (readonly [Capability, FeatureSwitchKey])[];

const AGENT_EXCLUDED_CAPABILITIES = [
  "agent:delete",
] as const satisfies readonly Capability[];

interface OkouTokenOptions {
  readonly computerUseHostId?: string;
  readonly cloudBrowserEnabled?: boolean;
  readonly imageRecognitionAvailable?: boolean;
  readonly customConnectorSourceIds?: Readonly<Record<string, string>>;
  readonly builtinConnectorSourceIds?: Readonly<Record<string, string>>;
}

const jwtBaseSchema = z.object({
  userId: z.string().min(1),
  scope: z.string(),
  iat: z.number(),
  exp: z.number(),
});

const sandboxTokenPayloadSchema = jwtBaseSchema.extend({
  piSandbox: z
    .object({
      ownerEpoch: z.number().int().positive(),
      generation: z.number().int().positive(),
    })
    .optional(),
  scope: z.literal("sandbox"),
  runId: z.string().min(1),
  orgId: z.string().min(1),
});

function isAgentCapability(value: string): value is Capability {
  return CAPABILITIES.some((capability) => {
    return capability === value;
  });
}

// Capability names are open-ended at the token boundary so tokens issued by a
// newer API remain valid on an older API. The validated output remains closed
// to known capabilities so unknown names cannot grant permissions.
const agentCapabilitiesSchema = z
  .array(z.string().min(1))
  .transform((capabilities) => {
    return capabilities.filter(isAgentCapability);
  })
  .readonly();

const okouTokenPayloadSchema = jwtBaseSchema.extend({
  scope: z.literal("okou"),
  runId: z.string().min(1),
  orgId: z.string().min(1),
  capabilities: agentCapabilitiesSchema,
  computerUseHostId: z.string().uuid().optional(),
  cloudBrowserEnabled: z.literal(true).optional(),
  customConnectorSourceIds: z
    .record(z.string().uuid(), z.string().uuid())
    .optional(),
  builtinConnectorSourceIds: z
    .record(connectorSlugSchema, z.string().uuid())
    .optional(),
});

type OkouTokenClaims = Omit<z.infer<typeof okouTokenPayloadSchema>, "scope">;

const cliTokenPayloadSchema = jwtBaseSchema.extend({
  scope: z.literal("cli"),
  orgId: z.string().min(1),
  tokenId: z.string().min(1),
});

const composeJobTokenPayloadSchema = jwtBaseSchema.extend({
  scope: z.literal("compose-job"),
  jobId: z.string().min(1),
});

type JwtPayloadInput =
  | z.input<typeof sandboxTokenPayloadSchema>
  | z.input<typeof okouTokenPayloadSchema>
  | z.input<typeof cliTokenPayloadSchema>
  | z.input<typeof composeJobTokenPayloadSchema>;

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

function isAgentCapabilityEnabled(
  capability: Capability,
  userId: string,
  orgId: string,
  overrides: Partial<Record<FeatureSwitchKey, boolean>> | undefined,
): boolean {
  const featureSwitch = featureSwitchForCapability(
    CONDITIONAL_CAPABILITIES,
    capability,
  );
  if (featureSwitch === undefined) {
    return true;
  }

  return isFeatureEnabled(featureSwitch, { userId, orgId, overrides });
}

function isCapabilityAvailableToAgent(
  capability: Capability,
  options: OkouTokenOptions | undefined,
): boolean {
  if (
    AGENT_EXCLUDED_CAPABILITIES.some((excludedCapability) => {
      return excludedCapability === capability;
    })
  ) {
    return false;
  }
  if (capability === "computer-use:write") {
    return options?.computerUseHostId !== undefined;
  }
  if (capability === "browser:read" || capability === "browser:write") {
    return options?.cloudBrowserEnabled === true;
  }
  if (capability === "image-recognition:write") {
    return options?.imageRecognitionAvailable === true;
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
    ...(parsed.data.piSandbox ? { piSandbox: parsed.data.piSandbox } : {}),
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
  piSandbox?: SandboxAuth["piSandbox"],
): string {
  const nowSeconds = Math.floor(now() / 1000);
  const payload: z.infer<typeof sandboxTokenPayloadSchema> = {
    scope: "sandbox",
    ...(piSandbox ? { piSandbox } : {}),
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
  overrides?: Partial<Record<FeatureSwitchKey, boolean>>,
  options?: OkouTokenOptions,
): string {
  return signOkouToken(
    buildOkouTokenClaims(userId, runId, orgId, overrides, options),
  );
}

function buildOkouTokenClaims(
  userId: string,
  runId: string,
  orgId: string,
  overrides: Partial<Record<FeatureSwitchKey, boolean>> | undefined,
  options: OkouTokenOptions | undefined,
): OkouTokenClaims {
  const nowSeconds = Math.floor(now() / 1000);
  const capabilities: Capability[] = [];
  for (const capability of CAPABILITIES) {
    if (!isCapabilityAvailableToAgent(capability, options)) {
      continue;
    }
    if (isAgentCapabilityEnabled(capability, userId, orgId, overrides)) {
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
  const payload: z.infer<typeof okouTokenPayloadSchema> = {
    scope: "okou",
    ...claims,
  };
  return SANDBOX_TOKEN_PREFIX + signJwt(payload);
}

export function generateCliToken(
  userId: string,
  orgId: string,
  tokenId: string,
): string {
  const nowSeconds = Math.floor(now() / 1000);
  const payload: z.infer<typeof cliTokenPayloadSchema> = {
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
  payload: z.infer<typeof cliTokenPayloadSchema>,
): string {
  return PAT_TOKEN_PREFIX + signJwt(payload);
}
