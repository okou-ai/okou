import type { RunContextResponse } from "@okouai/api-contracts/contracts/run-routes";
import {
  executionFirewallBuiltinEntrySchema,
  executionFirewallInlineEntrySchema,
  firewallAwsSigv4AuthSchema,
  firewallBaseHostPolicySchema,
  firewallPermissionSchema,
  type ExecutionFirewallInlineEntry,
  type ExecutionFirewalls,
  type NetworkPolicies,
} from "@okouai/connectors/firewall-types";
import { z } from "zod";
import type { PiModelConfigObservation } from "../../lib/pi-model-config-observation";

type UnknownRecord = Record<string, unknown>;
type NetworkPolicy = NetworkPolicies[string];
type NetworkPolicyValue = "allow" | "deny" | "ask";
type RunContextFirewall = RunContextResponse["firewalls"][number];
type RunContextBuiltinFirewall = Extract<
  RunContextFirewall,
  { kind: "builtin" }
>;
type RunContextSanitizedFirewall = Extract<
  RunContextFirewall,
  { apis: unknown }
>;
type RunContextExecutionInlineFirewall = Extract<
  RunContextFirewall,
  { kind: "inline" }
>;
type RunContextFirewallApi = RunContextSanitizedFirewall["apis"][number];
type RunContextFirewallPermission = NonNullable<
  RunContextFirewallApi["permissions"]
>[number];
type RunContextVolume = RunContextResponse["volumes"][number];

export interface RunContextEnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

export interface RunContextNetworkPolicyEntry {
  readonly name: string;
  readonly policy: NetworkPolicy;
}

export interface RunContextFeatureFlagEntry {
  readonly name: string;
  readonly enabled: boolean;
}

const runContextAxiomAuthEntrySchema = z.object({
  name: z.string(),
  value: z.string(),
});

const runContextAxiomFirewallAuthSchema = z.object({
  headerEntries: z.array(runContextAxiomAuthEntrySchema).optional(),
  base: z.string().min(1).optional(),
  queryEntries: z.array(runContextAxiomAuthEntrySchema).optional(),
  awsSigv4: firewallAwsSigv4AuthSchema.optional(),
});

const runContextAxiomInlineFirewallSchema = z.object({
  kind: z.literal("inline"),
  name: z.string().min(1),
  customConnectorId: z.uuid().optional(),
  sourceId: z.uuid().optional(),
  apis: z.array(
    z.object({
      id: z.string().min(1).optional(),
      base: z.string(),
      hostPolicy: firewallBaseHostPolicySchema.optional(),
      auth: runContextAxiomFirewallAuthSchema,
      permissions: z.array(firewallPermissionSchema).optional(),
    }),
  ),
});

type RunContextAxiomInlineFirewall = z.infer<
  typeof runContextAxiomInlineFirewallSchema
>;
type RunContextAxiomFirewall =
  | RunContextBuiltinFirewall
  | RunContextAxiomInlineFirewall;

// Pi generation observations are creation-time only. Historical snapshots may
// also carry retired field classifications; neither enters RunContextResponse.
export type RunContextAxiomSnapshot = Omit<
  RunContextResponse,
  "vars" | "environment" | "firewalls" | "networkPolicies" | "featureFlags"
> &
  Partial<PiModelConfigObservation> & {
    readonly _time: string;
    readonly userId: string;
    readonly cliAgentType?: string;
    readonly environmentEntries: readonly RunContextEnvironmentEntry[];
    readonly firewalls: readonly RunContextAxiomFirewall[];
    readonly networkPolicyEntries: readonly RunContextNetworkPolicyEntry[];
    readonly featureFlagEntries: readonly RunContextFeatureFlagEntry[];
  };

interface NormalizedRunContextSnapshot {
  readonly runId?: string;
  readonly userId?: string;
  readonly prompt?: string;
  readonly appendSystemPrompt?: string | null;
  readonly sessionId: string | null;
  readonly cliAgentType: string | null;
  readonly secretNames: readonly string[];
  readonly environment: Record<string, string>;
  readonly firewalls: RunContextResponse["firewalls"];
  readonly networkPolicies: RunContextResponse["networkPolicies"];
  readonly volumes: RunContextResponse["volumes"];
  readonly artifact: RunContextResponse["artifact"];
  readonly featureFlags: Record<string, boolean> | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => {
    return typeof item === "string";
  });
  return strings.length === value.length ? strings : undefined;
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    },
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function networkPolicyValue(value: unknown): NetworkPolicyValue | undefined {
  return value === "allow" || value === "deny" || value === "ask"
    ? value
    : undefined;
}

function networkPolicyFromUnknown(value: unknown): NetworkPolicy | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const unknownPolicy = networkPolicyValue(value.unknownPolicy);
  if (!unknownPolicy) {
    return undefined;
  }
  return {
    allow: stringArrayValue(value.allow) ?? [],
    deny: stringArrayValue(value.deny) ?? [],
    ask: stringArrayValue(value.ask) ?? [],
    unknownPolicy,
  };
}

function environmentFromEntries(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) {
    return {};
  }
  const entries: [string, string][] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const name = stringValue(item.name);
    const entryValue = stringValue(item.value);
    if (name && entryValue !== undefined) {
      entries.push([name, entryValue]);
    }
  }
  return Object.fromEntries(entries);
}

function networkPoliciesFromEntries(
  value: unknown,
): RunContextResponse["networkPolicies"] {
  if (!Array.isArray(value)) {
    return null;
  }
  const policies: NetworkPolicies = {};
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const name = stringValue(item.name);
    const policy = networkPolicyFromUnknown(item.policy);
    if (name && policy) {
      policies[name] = policy;
    }
  }
  return Object.keys(policies).length > 0 ? policies : null;
}

function firewallPermissionFromUnknown(
  value: unknown,
): RunContextFirewallPermission | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = stringValue(value.name);
  const rules = stringArrayValue(value.rules);
  if (!name || !rules) {
    return undefined;
  }
  const description = stringValue(value.description);
  return description === undefined
    ? { name, rules }
    : { name, description, rules };
}

function firewallApiFromUnknown(
  value: unknown,
): RunContextFirewallApi | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const base = stringValue(value.base);
  if (!base) {
    return undefined;
  }
  if (!Array.isArray(value.permissions)) {
    return { base };
  }
  return {
    base,
    permissions: value.permissions.flatMap((permission) => {
      const normalized = firewallPermissionFromUnknown(permission);
      return normalized ? [normalized] : [];
    }),
  };
}

function builtinFirewallFromUnknown(
  value: UnknownRecord,
): RunContextBuiltinFirewall | undefined {
  if (value.kind !== "builtin") {
    return undefined;
  }
  const name = stringValue(value.name);
  if (!name) {
    return undefined;
  }
  const baseUrlVars = stringRecordValue(value.baseUrlVars);
  const parsedSourceId =
    executionFirewallBuiltinEntrySchema.shape.sourceId.safeParse(
      value.sourceId,
    );
  const sourceId = parsedSourceId.success ? parsedSourceId.data : undefined;
  return {
    kind: "builtin",
    name,
    ...(baseUrlVars === undefined ? {} : { baseUrlVars }),
    ...(sourceId === undefined ? {} : { sourceId }),
  };
}

function sanitizedFirewallFromUnknown(
  value: UnknownRecord,
): RunContextSanitizedFirewall | undefined {
  const name = stringValue(value.name);
  if (!name || !Array.isArray(value.apis)) {
    return undefined;
  }
  return {
    name,
    apis: value.apis.flatMap((api) => {
      const normalized = firewallApiFromUnknown(api);
      return normalized ? [normalized] : [];
    }),
  };
}

function authEntriesToRecord(
  entries:
    | readonly z.infer<typeof runContextAxiomAuthEntrySchema>[]
    | undefined,
): Record<string, string> | undefined {
  return entries === undefined
    ? undefined
    : Object.fromEntries(
        entries.map((entry) => {
          return [entry.name, entry.value];
        }),
      );
}

function executionInlineFirewallFromUnknown(
  value: UnknownRecord,
): RunContextExecutionInlineFirewall | undefined {
  const parsed = runContextAxiomInlineFirewallSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const executionEntry = {
    kind: "inline",
    ...(parsed.data.customConnectorId === undefined
      ? {}
      : { customConnectorId: parsed.data.customConnectorId }),
    ...(parsed.data.sourceId === undefined
      ? {}
      : { sourceId: parsed.data.sourceId }),
    firewall: {
      name: parsed.data.name,
      apis: parsed.data.apis.map((api) => {
        const headers = authEntriesToRecord(api.auth.headerEntries);
        const query = authEntriesToRecord(api.auth.queryEntries);
        return {
          ...(api.id === undefined ? {} : { id: api.id }),
          base: api.base,
          ...(api.hostPolicy === undefined
            ? {}
            : { hostPolicy: api.hostPolicy }),
          auth: {
            ...(headers === undefined ? {} : { headers }),
            ...(api.auth.base === undefined ? {} : { base: api.auth.base }),
            ...(query === undefined ? {} : { query }),
            ...(api.auth.awsSigv4 === undefined
              ? {}
              : { awsSigv4: api.auth.awsSigv4 }),
          },
          ...(api.permissions === undefined
            ? {}
            : { permissions: api.permissions }),
        };
      }),
    },
  };
  const normalized =
    executionFirewallInlineEntrySchema.safeParse(executionEntry);
  if (!normalized.success) {
    return undefined;
  }
  return {
    kind: "inline",
    ...normalized.data.firewall,
    ...(normalized.data.customConnectorId === undefined
      ? {}
      : { customConnectorId: normalized.data.customConnectorId }),
    ...(normalized.data.sourceId === undefined
      ? {}
      : { sourceId: normalized.data.sourceId }),
  };
}

function firewallsFromUnknown(value: unknown): RunContextResponse["firewalls"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const firewalls: RunContextResponse["firewalls"] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.kind === "builtin") {
      const normalized = builtinFirewallFromUnknown(item);
      if (normalized) {
        firewalls.push(normalized);
      }
      continue;
    }
    if (item.kind === "inline") {
      const normalized = executionInlineFirewallFromUnknown(item);
      if (normalized) {
        firewalls.push(normalized);
        continue;
      }
    }
    const normalized = sanitizedFirewallFromUnknown(item);
    if (normalized) {
      firewalls.push(normalized);
    }
  }
  return firewalls;
}

function volumeFromUnknown(value: unknown): RunContextVolume | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = stringValue(value.name);
  const mountPath = stringValue(value.mountPath);
  const vasStorageName = stringValue(value.vasStorageName);
  const vasVersionId = stringValue(value.vasVersionId);
  return name && mountPath && vasStorageName && vasVersionId
    ? { name, mountPath, vasStorageName, vasVersionId }
    : undefined;
}

function volumesFromUnknown(value: unknown): RunContextResponse["volumes"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const normalized = volumeFromUnknown(item);
    return normalized ? [normalized] : [];
  });
}

function artifactFromUnknown(value: unknown): RunContextResponse["artifact"] {
  if (!isRecord(value)) {
    return null;
  }
  const mountPath = stringValue(value.mountPath);
  const vasStorageName = stringValue(value.vasStorageName);
  const vasVersionId = stringValue(value.vasVersionId);
  return mountPath && vasStorageName && vasVersionId
    ? { mountPath, vasStorageName, vasVersionId }
    : null;
}

function featureFlagsFromEntries(
  value: unknown,
): Record<string, boolean> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: [string, boolean][] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const name = stringValue(item.name);
    if (name && typeof item.enabled === "boolean") {
      entries.push([name, item.enabled]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function stringArrayFromUnknown(value: unknown): string[] {
  return stringArrayValue(value) ?? [];
}

export function environmentRecordToEntries(
  environment: Record<string, string>,
): RunContextEnvironmentEntry[] {
  return Object.entries(environment).map(([name, value]) => {
    return { name, value };
  });
}

export function networkPoliciesRecordToEntries(
  networkPolicies: NetworkPolicies | null | undefined,
): RunContextNetworkPolicyEntry[] {
  if (!networkPolicies) {
    return [];
  }
  return Object.entries(networkPolicies).map(([name, policy]) => {
    return { name, policy };
  });
}

export function featureFlagsRecordToEntries(
  featureFlags: Record<string, boolean> | null | undefined,
): RunContextFeatureFlagEntry[] {
  if (!featureFlags) {
    return [];
  }
  return Object.entries(featureFlags).map(([name, enabled]) => {
    return { name, enabled };
  });
}

function authRecordToEntries(
  values: Record<string, string> | undefined,
): z.infer<typeof runContextAxiomAuthEntrySchema>[] | undefined {
  return values === undefined
    ? undefined
    : Object.entries(values).map(([name, value]) => {
        return { name, value };
      });
}

function inlineFirewallToAxiomEntry(
  entry: ExecutionFirewallInlineEntry,
): RunContextAxiomInlineFirewall {
  return {
    kind: "inline",
    name: entry.firewall.name,
    ...(entry.customConnectorId === undefined
      ? {}
      : { customConnectorId: entry.customConnectorId }),
    ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
    apis: entry.firewall.apis.map((api) => {
      const headerEntries = authRecordToEntries(api.auth.headers);
      const queryEntries = authRecordToEntries(api.auth.query);
      return {
        ...(api.id === undefined ? {} : { id: api.id }),
        base: api.base,
        ...(api.hostPolicy === undefined ? {} : { hostPolicy: api.hostPolicy }),
        auth: {
          ...(headerEntries === undefined ? {} : { headerEntries }),
          ...(api.auth.base === undefined ? {} : { base: api.auth.base }),
          ...(queryEntries === undefined ? {} : { queryEntries }),
          ...(api.auth.awsSigv4 === undefined
            ? {}
            : { awsSigv4: api.auth.awsSigv4 }),
        },
        ...(api.permissions === undefined
          ? {}
          : { permissions: api.permissions }),
      };
    }),
  };
}

export function executionFirewallsToAxiomEntries(
  firewalls: ExecutionFirewalls | null | undefined,
): RunContextAxiomFirewall[] {
  return (firewalls ?? []).map((entry) => {
    return entry.kind === "inline" ? inlineFirewallToAxiomEntry(entry) : entry;
  });
}

export function normalizeRunContextSnapshot(
  snapshot: Record<string, unknown>,
): NormalizedRunContextSnapshot {
  return {
    runId: stringValue(snapshot.runId),
    userId: stringValue(snapshot.userId),
    prompt: stringValue(snapshot.prompt),
    appendSystemPrompt:
      typeof snapshot.appendSystemPrompt === "string" ||
      snapshot.appendSystemPrompt === null
        ? snapshot.appendSystemPrompt
        : undefined,
    sessionId: stringValue(snapshot.sessionId) ?? null,
    cliAgentType: stringValue(snapshot.cliAgentType) ?? null,
    secretNames: stringArrayFromUnknown(snapshot.secretNames),
    environment: environmentFromEntries(snapshot.environmentEntries),
    firewalls: firewallsFromUnknown(snapshot.firewalls),
    networkPolicies: networkPoliciesFromEntries(snapshot.networkPolicyEntries),
    volumes: volumesFromUnknown(snapshot.volumes),
    artifact: artifactFromUnknown(snapshot.artifact),
    featureFlags: featureFlagsFromEntries(snapshot.featureFlagEntries),
  };
}
