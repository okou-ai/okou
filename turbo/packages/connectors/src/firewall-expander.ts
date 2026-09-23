import {
  type FirewallConfig,
  UNKNOWN_PERMISSION_GRANT,
  validateAuthBaseUrl,
  validateBaseUrlHostPolicy,
  validateBaseUrl,
} from "./firewall-types";
import { hasRawWhitespace, hasUnsafeUrlCodepoint } from "./firewall-url-utils";
import { parseSegment, splitPathSegments } from "./segment-parser";

const VALID_RULE_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ANY",
]);
const AWS_RULE_SEPARATOR = " AWS ";
export const AWS_PREDICATE_VALUE_RE = /^[A-Za-z0-9._:-]+$/;
export const AWS_QUERY_KEY_RE = /^[A-Za-z0-9._~-]+$/;
export const AWS_QUERY_VALUE_RE = /^[A-Za-z0-9._~:{}-]+$/;
const VALID_AWS_PREDICATE_KEYS = new Set(["sigv4", "action", "target"]);
export const AWS_S3_PERMISSION_HEADER_NAMES = [
  "x-amz-copy-source",
  "x-amz-bypass-governance-retention",
  "x-amz-acl",
  "x-amz-grant-full-control",
  "x-amz-grant-read",
  "x-amz-grant-read-acp",
  "x-amz-grant-write",
  "x-amz-grant-write-acp",
  "x-amz-object-lock-legal-hold",
  "x-amz-object-lock-mode",
  "x-amz-object-lock-retain-until-date",
  "x-amz-tagging",
] as const;
export const AWS_S3_PERMISSION_HEADER_QUERY_KEYS: Readonly<
  Record<(typeof AWS_S3_PERMISSION_HEADER_NAMES)[number], readonly string[]>
> = {
  "x-amz-copy-source": [],
  "x-amz-bypass-governance-retention": [],
  "x-amz-acl": ["acl"],
  "x-amz-grant-full-control": ["acl"],
  "x-amz-grant-read": ["acl"],
  "x-amz-grant-read-acp": ["acl"],
  "x-amz-grant-write": ["acl"],
  "x-amz-grant-write-acp": ["acl"],
  "x-amz-object-lock-legal-hold": ["legal-hold"],
  "x-amz-object-lock-mode": ["retention"],
  "x-amz-object-lock-retain-until-date": ["retention"],
  "x-amz-tagging": ["tagging"],
};

export interface ParsedRuleRemainder {
  readonly path: string;
  readonly queryRequirements?: readonly string[];
  readonly awsPredicates?: ReadonlyMap<string, string>;
}

function invalidRule(
  rule: string,
  permName: string,
  serviceName: string,
  reason: string,
): Error {
  return new Error(
    `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": ${reason}`,
  );
}

function parseAwsPredicates(
  predicateText: string,
  rule: string,
  permName: string,
  serviceName: string,
): ReadonlyMap<string, string> {
  if (predicateText === "") {
    throw invalidRule(
      rule,
      permName,
      serviceName,
      'AWS predicates are required after "AWS"',
    );
  }

  const predicates = new Map<string, string>();
  for (const token of predicateText.split(" ")) {
    if (token === "") {
      throw invalidRule(
        rule,
        permName,
        serviceName,
        "AWS predicates must be separated by a single space",
      );
    }
    const [key, value, extra] = token.split("=");
    if (extra !== undefined || !key || !value) {
      throw invalidRule(
        rule,
        permName,
        serviceName,
        `AWS predicate "${token}" must be key=value`,
      );
    }
    if (!VALID_AWS_PREDICATE_KEYS.has(key)) {
      throw invalidRule(
        rule,
        permName,
        serviceName,
        `unsupported AWS predicate "${key}"`,
      );
    }
    if (predicates.has(key)) {
      throw invalidRule(
        rule,
        permName,
        serviceName,
        `duplicate AWS predicate "${key}"`,
      );
    }
    if (!AWS_PREDICATE_VALUE_RE.test(value)) {
      throw invalidRule(
        rule,
        permName,
        serviceName,
        `AWS predicate "${key}" has an invalid value`,
      );
    }
    predicates.set(key, value);
  }

  if (!predicates.has("sigv4")) {
    throw invalidRule(
      rule,
      permName,
      serviceName,
      'AWS predicate "sigv4" is required',
    );
  }
  if (predicates.has("action") && predicates.has("target")) {
    throw invalidRule(
      rule,
      permName,
      serviceName,
      'AWS predicates "action" and "target" cannot be combined',
    );
  }

  return predicates;
}

function parseAwsQueryRequirements(
  rawQuery: string,
  rule: string,
  permName: string,
  serviceName: string,
): readonly string[] {
  if (rawQuery === "") {
    throw invalidRule(
      rule,
      permName,
      serviceName,
      "AWS query requirements must not be empty",
    );
  }

  const keys = new Set<string>();
  const requirements: string[] = [];
  for (const token of rawQuery.split("&")) {
    if (token === "") {
      throw invalidRule(
        rule,
        permName,
        serviceName,
        "AWS query requirements must not contain empty entries",
      );
    }

    const [key, value, extra] = token.split("=");
    if (extra !== undefined || !key || !AWS_QUERY_KEY_RE.test(key)) {
      throw invalidRule(
        rule,
        permName,
        serviceName,
        `AWS query requirement "${token}" has an invalid key`,
      );
    }
    if (keys.has(key)) {
      throw invalidRule(
        rule,
        permName,
        serviceName,
        `duplicate AWS query requirement "${key}"`,
      );
    }
    keys.add(key);

    if (
      value !== undefined &&
      value !== "*" &&
      (value === "" || !AWS_QUERY_VALUE_RE.test(value))
    ) {
      throw invalidRule(
        rule,
        permName,
        serviceName,
        `AWS query requirement "${token}" has an invalid value`,
      );
    }
    requirements.push(token);
  }

  return requirements;
}

export function parseRuleRemainder(
  rest: string,
  rule: string,
  permName: string,
  serviceName: string,
): ParsedRuleRemainder {
  const separatorIndex = rest.indexOf(AWS_RULE_SEPARATOR);
  if (separatorIndex === -1) {
    return { path: rest };
  }
  if (rest.indexOf(AWS_RULE_SEPARATOR, separatorIndex + 1) !== -1) {
    throw invalidRule(
      rule,
      permName,
      serviceName,
      "AWS predicates may appear only once",
    );
  }

  const rawPath = rest.slice(0, separatorIndex);
  const predicateText = rest.slice(separatorIndex + AWS_RULE_SEPARATOR.length);
  if (!rawPath) {
    throw invalidRule(rule, permName, serviceName, 'path must start with "/"');
  }

  const awsPredicates = parseAwsPredicates(
    predicateText,
    rule,
    permName,
    serviceName,
  );
  const queryIndex = rawPath.indexOf("?");
  if (queryIndex === -1) {
    return { path: rawPath, awsPredicates };
  }

  return {
    path: rawPath.slice(0, queryIndex),
    queryRequirements: parseAwsQueryRequirements(
      rawPath.slice(queryIndex + 1),
      rule,
      permName,
      serviceName,
    ),
    awsPredicates,
  };
}

function validatePathSegments(
  path: string,
  rule: string,
  permName: string,
  serviceName: string,
): void {
  if (!path.startsWith("/")) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must start with "/"`,
    );
  }
  if (hasRawWhitespace(path)) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must not contain whitespace`,
    );
  }
  if (hasUnsafeUrlCodepoint(path)) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must not contain control characters or invalid Unicode`,
    );
  }
  if (path.includes("\\")) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must not contain backslash`,
    );
  }
  if (path.includes("?") || path.includes("#")) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must not contain query string or fragment`,
    );
  }
  const segments = splitPathSegments(path);
  const paramNames = new Set<string>();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": ${parsed.reason}`,
      );
    }
    if (parsed.kind === "literal") continue;
    const { name, greedy, prefix, suffix } = parsed;
    if (paramNames.has(name)) {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": duplicate parameter name "{${name}}"`,
      );
    }
    paramNames.add(name);
    if (greedy && i !== segments.length - 1) {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": {${name}${greedy}} must be the last segment`,
      );
    }
    if (greedy && (prefix !== "" || suffix !== "")) {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": greedy parameter {${name}${greedy}} cannot be combined with a literal prefix or suffix in segment "${seg}"`,
      );
    }
  }
}

export function validateRule(
  rule: string,
  permName: string,
  serviceName: string,
  options: { readonly allowAwsPredicates?: boolean } = {},
): void {
  const spaceIdx = rule.indexOf(" ");
  if (spaceIdx === -1) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": must be "METHOD /path"`,
    );
  }
  const method = rule.slice(0, spaceIdx);
  const rest = rule.slice(spaceIdx + 1);
  if (!method || !rest) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": must be "METHOD /path"`,
    );
  }
  if (!VALID_RULE_METHODS.has(method)) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": unknown method "${method}" (must be uppercase)`,
    );
  }

  const parsed = parseRuleRemainder(rest, rule, permName, serviceName);
  if (parsed.awsPredicates && options.allowAwsPredicates !== true) {
    throw invalidRule(
      rule,
      permName,
      serviceName,
      "AWS predicates require api.auth.awsSigv4",
    );
  }
  validatePathSegments(parsed.path, rule, permName, serviceName);
}

/**
 * Collect available permission names from a firewall config.
 * Validates uniqueness and that "all" is not used as a permission name.
 */
export function collectAndValidatePermissions(
  serviceConfig: FirewallConfig,
): Set<string> {
  if (serviceConfig.apis.length === 0) {
    throw new Error(`Firewall "${serviceConfig.name}" has no api entries`);
  }
  const available = new Set<string>();
  for (const api of serviceConfig.apis) {
    validateBaseUrl(api.base, serviceConfig.name);
    validateBaseUrlHostPolicy({
      base: api.base,
      serviceName: serviceConfig.name,
      hostPolicy: api.hostPolicy,
    });
    if (api.auth.base !== undefined) {
      validateAuthBaseUrl(api.auth.base, serviceConfig.name);
    }
    if (!api.permissions || api.permissions.length === 0) {
      // Empty permissions is a valid shape: every request under this base
      // falls through to the firewall's unknownPolicy. Auth headers are
      // still injected on base URL match.
      continue;
    }
    // Uniqueness is enforced within a single api_entry. The same permission
    // name across different api_entries is allowed (e.g., "full-access" on
    // both slack.com/api and files.slack.com).
    const seen = new Set<string>();
    for (const perm of api.permissions) {
      if (!perm.name) {
        throw new Error(
          `Firewall "${serviceConfig.name}" has a permission with empty name`,
        );
      }
      if (perm.name === "all" || perm.name === UNKNOWN_PERMISSION_GRANT) {
        throw new Error(
          `Firewall "${serviceConfig.name}" has a permission named "${perm.name}", which is a reserved keyword`,
        );
      }
      if (seen.has(perm.name)) {
        throw new Error(
          `Duplicate permission name "${perm.name}" in API entry "${api.base}" of firewall "${serviceConfig.name}"`,
        );
      }
      if (perm.rules.length === 0) {
        throw new Error(
          `Permission "${perm.name}" in firewall "${serviceConfig.name}" has no rules`,
        );
      }
      for (const rule of perm.rules) {
        validateRule(rule, perm.name, serviceConfig.name, {
          allowAwsPredicates: api.auth.awsSigv4 !== undefined,
        });
      }
      seen.add(perm.name);
      available.add(perm.name);
    }
  }
  return available;
}
