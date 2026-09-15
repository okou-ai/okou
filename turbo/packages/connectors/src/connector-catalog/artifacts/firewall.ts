import { isIP } from "node:net";

import {
  firewallBaseUrlTemplateNeedsHostPolicy,
  validateAuthBaseUrl,
  validateBaseUrl,
  validateBaseUrlHostPolicy,
} from "../../firewall-types";
import { z } from "zod";

import { connectorSlugSchema, privateNameSchema } from "./common";
import { ConnectorCatalogRelationshipError } from "./relationship-error";

const TEMPLATE_REFERENCE_PATTERN = /\b(secrets|vars)\.([A-Z][A-Z0-9_]*)\b/gu;
const DIRECT_TEMPLATE_PATTERN =
  /\$\{\{\s*(?:secrets|vars)\.[A-Z][A-Z0-9_]*\s*\}\}/gu;
const BASE_URL_PARAMETER_PATTERN = /\{[A-Za-z][A-Za-z0-9]*(?:[+*])?\}/gu;
const BASE_VARIABLE_CAPTURE_PATTERN =
  /\$\{\{\s*vars\.([A-Z][A-Z0-9_]*)\s*\}\}/gu;
const FULL_BASE_VARIABLE_PATTERN =
  /^\$\{\{\s*vars\.[A-Z][A-Z0-9_]*\s*\}\}(\/.*)?$/u;
const BASE_SECRET_PATTERN = /\$\{\{\s*secrets\.[A-Z][A-Z0-9_]*\s*\}\}/u;
const HOST_FORBIDDEN_CHARACTERS = String.raw`%*[]\/?:#@{}`;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

export const firewallPolicyValueSchema = z.enum(["allow", "deny", "ask"]);

const firewallPermissionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    rules: z.array(z.string().regex(/^[A-Z]+ \/\S*$/u)),
  })
  .strict();

const firewallAwsSigv4AuthSchema = z
  .object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().min(1).optional(),
  })
  .strict();

const firewallAuthSchema = z
  .object({
    headers: z.record(z.string().min(1), z.string()).optional(),
    base: z.string().min(1).optional(),
    query: z.record(z.string().min(1), z.string()).optional(),
    awsSigv4: firewallAwsSigv4AuthSchema.optional(),
  })
  .strict()
  .superRefine((auth, context) => {
    if (auth.awsSigv4 === undefined) {
      return;
    }
    if (auth.headers !== undefined && Object.keys(auth.headers).length > 0) {
      context.addIssue({
        code: "custom",
        path: ["headers"],
        message: "auth.headers cannot be combined with auth.awsSigv4",
      });
    }
    if (auth.query !== undefined && Object.keys(auth.query).length > 0) {
      context.addIssue({
        code: "custom",
        path: ["query"],
        message: "auth.query cannot be combined with auth.awsSigv4",
      });
    }
    if (auth.base !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["base"],
        message: "auth.base cannot be combined with auth.awsSigv4",
      });
    }
  });

function hostHasFixedOwnership(
  value: string,
  allowLeadingDot: boolean,
): boolean {
  if (!allowLeadingDot && value.startsWith(".")) {
    return false;
  }
  const withoutLeadingDot =
    allowLeadingDot && value.startsWith(".") ? value.slice(1) : value;
  const normalized = withoutLeadingDot.endsWith(".")
    ? withoutLeadingDot.slice(0, -1).toLowerCase()
    : withoutLeadingDot.toLowerCase();
  if (
    normalized === "" ||
    withoutLeadingDot !== normalized ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    [...HOST_FORBIDDEN_CHARACTERS].some((character) => {
      return normalized.includes(character);
    }) ||
    isIP(normalized) !== 0 ||
    /^[0-9.]+$/u.test(normalized)
  ) {
    return false;
  }
  const labels = normalized.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => {
      return HOST_LABEL_PATTERN.test(label) && label.length <= 63;
    })
  );
}

const providerOwnedHostPolicySchema = z
  .object({
    kind: z.literal("providerOwned"),
    exactHosts: z.array(z.string().min(1)).optional(),
    suffixes: z.array(z.string().min(1)).optional(),
    allowNonDefaultPort: z.boolean().optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      (policy.exactHosts?.length ?? 0) === 0 &&
      (policy.suffixes?.length ?? 0) === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "providerOwned host policy requires exactHosts or suffixes",
      });
    }
    for (const [index, host] of (policy.exactHosts ?? []).entries()) {
      if (!hostHasFixedOwnership(host, false)) {
        context.addIssue({
          code: "custom",
          path: ["exactHosts", index],
          message:
            "providerOwned exactHosts must contain fixed hostnames with at least two labels",
        });
      }
    }
    for (const [index, suffix] of (policy.suffixes ?? []).entries()) {
      if (!hostHasFixedOwnership(suffix, true)) {
        context.addIssue({
          code: "custom",
          path: ["suffixes", index],
          message:
            "providerOwned suffixes must contain fixed hostnames with at least two labels",
        });
      }
    }
  });

const publicDestinationHostPolicySchema = z
  .object({ kind: z.literal("publicDestination") })
  .strict();

const firewallHostPolicySchema = z.discriminatedUnion("kind", [
  providerOwnedHostPolicySchema,
  publicDestinationHostPolicySchema,
]);

const firewallApiSchema = z
  .object({
    base: z.string().min(1),
    hostPolicy: firewallHostPolicySchema.optional(),
    auth: firewallAuthSchema,
    permissions: z.array(firewallPermissionSchema).optional(),
  })
  .strict();

export const firewallConfigSchema = z
  .object({
    name: connectorSlugSchema,
    description: z.string().min(1).optional(),
    placeholders: z.record(privateNameSchema, z.string()).optional(),
    apis: z.array(firewallApiSchema).min(1),
  })
  .strict();

export const firewallCategoriesSchema = z
  .object({
    byPermission: z.record(z.string().min(1), z.string().min(1)),
    displayOrder: z.array(z.string().min(1)).min(1),
  })
  .strict();

type FirewallApi = z.infer<typeof firewallApiSchema>;
type FirewallConfig = z.infer<typeof firewallConfigSchema>;
interface FirewallGeneratorResult {
  readonly firewall: FirewallConfig;
  readonly categories: z.infer<typeof firewallCategoriesSchema> | null;
  readonly defaultAllowed: readonly string[] | null;
  readonly defaultUnknownPolicy: z.infer<typeof firewallPolicyValueSchema>;
}

function duplicateStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
}

function firewallPermissionNames(firewall: FirewallConfig): Set<string> {
  const names = new Set<string>();
  for (const api of firewall.apis) {
    for (const permission of api.permissions ?? []) {
      names.add(permission.name);
      const duplicateRules = duplicateStrings(permission.rules);
      if (duplicateRules.length > 0) {
        throw new ConnectorCatalogRelationshipError(
          "duplicate-firewall-permission-rule",
          `Duplicate rules for firewall permission ${permission.name}: ${duplicateRules.join(", ")}`,
        );
      }
    }
  }
  return names;
}

export function firewallTemplateReferences(value: unknown): {
  readonly secrets: ReadonlySet<string>;
  readonly vars: ReadonlySet<string>;
} {
  const secrets = new Set<string>();
  const vars = new Set<string>();
  function visit(candidate: unknown): void {
    if (typeof candidate === "string") {
      for (const match of candidate.matchAll(TEMPLATE_REFERENCE_PATTERN)) {
        const kind = match[1];
        const name = match[2];
        if (kind === undefined || name === undefined) {
          continue;
        }
        (kind === "secrets" ? secrets : vars).add(name);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const child of candidate) {
        visit(child);
      }
      return;
    }
    if (typeof candidate === "object" && candidate !== null) {
      for (const child of Object.values(candidate)) {
        visit(child);
      }
    }
  }
  visit(value);
  return { secrets, vars };
}

function normalizedFirewallBaseUrl(base: string): string {
  const fullVariableMatch = base.match(FULL_BASE_VARIABLE_PATTERN);
  if (fullVariableMatch !== null) {
    return `https://variable.invalid${fullVariableMatch[1] ?? ""}`;
  }
  return base.replace(DIRECT_TEMPLATE_PATTERN, "variable");
}

function rawUrlHostname(value: string): string | undefined {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd === -1) {
    return undefined;
  }
  const authorityStart = schemeEnd + 3;
  const pathStart = value.indexOf("/", authorityStart);
  const authority = value.slice(
    authorityStart,
    pathStart === -1 ? value.length : pathStart,
  );
  if (authority.startsWith("[")) {
    const bracketEnd = authority.indexOf("]");
    return bracketEnd === -1 ? undefined : authority.slice(0, bracketEnd + 1);
  }
  const portSeparator = authority.lastIndexOf(":");
  return portSeparator === -1 ? authority : authority.slice(0, portSeparator);
}

function assertCanonicalFirewallBaseHostname(normalizedBase: string): void {
  const comparableBase = normalizedBase.replace(
    BASE_URL_PARAMETER_PATTERN,
    "variable",
  );
  const parsedComparableBase = URL.parse(comparableBase) ?? undefined;
  const rawHostname = rawUrlHostname(comparableBase);
  if (
    parsedComparableBase === undefined ||
    rawHostname === undefined ||
    rawHostname.endsWith(".") ||
    rawHostname !== parsedComparableBase.hostname
  ) {
    throw new ConnectorCatalogRelationshipError(
      "noncanonical-firewall-hostname",
      "Firewall API base hostname literals must use canonical lowercase ASCII",
    );
  }
}

export function parseFirewallBaseUrl(
  base: string,
  connectorSlug = "connector-catalog",
): URL {
  if (BASE_SECRET_PATTERN.test(base)) {
    throw new ConnectorCatalogRelationshipError(
      "firewall-base-secret",
      "Firewall API base URLs must use connector variables",
    );
  }
  validateBaseUrl(base, connectorSlug);
  const normalizedBase = normalizedFirewallBaseUrl(base);
  const parsed = URL.parse(normalizedBase) ?? undefined;
  if (
    parsed === undefined ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new ConnectorCatalogRelationshipError(
      "invalid-firewall-base-url",
      `Firewall base URL must be a clean HTTPS URL: ${base}`,
    );
  }
  assertCanonicalFirewallBaseHostname(normalizedBase);
  return parsed;
}

export function firewallBaseVariableNames(base: string): string[] {
  return [
    ...new Set(
      [...base.matchAll(BASE_VARIABLE_CAPTURE_PATTERN)].flatMap((match) => {
        return match[1] === undefined ? [] : [match[1]];
      }),
    ),
  ].sort();
}

export function firewallAuthInjectsCredentials(auth: {
  readonly base?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly awsSigv4?: unknown;
}): boolean {
  return (
    auth.base !== undefined ||
    Object.keys(auth.headers ?? {}).length > 0 ||
    Object.keys(auth.query ?? {}).length > 0 ||
    auth.awsSigv4 !== undefined
  );
}

function validateHostPolicy(connectorSlug: string, api: FirewallApi): void {
  if (
    firewallAuthInjectsCredentials(api.auth) &&
    firewallBaseUrlTemplateNeedsHostPolicy(api.base)
  ) {
    if (api.hostPolicy === undefined) {
      throw new ConnectorCatalogRelationshipError(
        "missing-firewall-host-policy",
        `Credentialed dynamic base URL requires hostPolicy for ${connectorSlug}: ${api.base}`,
      );
    }
  }
}

export function validateFirewallGeneratorResult(
  result: FirewallGeneratorResult,
): void {
  const connectorSlug = result.firewall.name;
  const permissionNames = firewallPermissionNames(result.firewall);
  for (const api of result.firewall.apis) {
    parseFirewallBaseUrl(api.base, connectorSlug);
    validateBaseUrlHostPolicy({
      base: api.base,
      serviceName: connectorSlug,
      hostPolicy: api.hostPolicy,
    });
    if (api.auth.base !== undefined) {
      validateAuthBaseUrl(api.auth.base, connectorSlug);
    }
    validateHostPolicy(connectorSlug, api);
  }

  if (result.categories !== null) {
    const categorized = new Set(Object.keys(result.categories.byPermission));
    const missing = [...permissionNames].filter((name) => {
      return !categorized.has(name);
    });
    const unknown = [...categorized].filter((name) => {
      return !permissionNames.has(name);
    });
    if (missing.length > 0 || unknown.length > 0) {
      throw new ConnectorCatalogRelationshipError(
        "firewall-permission-categories",
        `Firewall categories do not match permissions for ${connectorSlug}`,
      );
    }
    const categoryNames = new Set(
      Object.values(result.categories.byPermission),
    );
    const displayNames = result.categories.displayOrder;
    if (
      duplicateStrings(displayNames).length > 0 ||
      displayNames.some((name) => {
        return !categoryNames.has(name);
      }) ||
      [...categoryNames].some((name) => {
        return !displayNames.includes(name);
      })
    ) {
      throw new ConnectorCatalogRelationshipError(
        "firewall-category-order",
        `Firewall category order does not match categories for ${connectorSlug}`,
      );
    }
  }

  if (result.defaultAllowed !== null) {
    const duplicates = duplicateStrings(result.defaultAllowed);
    const unknown = result.defaultAllowed.filter((name) => {
      return !permissionNames.has(name);
    });
    if (duplicates.length > 0 || unknown.length > 0) {
      throw new ConnectorCatalogRelationshipError(
        "firewall-default-allowlist",
        `Firewall default allowlist is invalid for ${connectorSlug}`,
      );
    }
  }
}
