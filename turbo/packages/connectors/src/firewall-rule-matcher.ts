import {
  type FirewallConfig,
  hasUnsafeFirewallPath,
  hasBaseUrlParams,
  validateAuthBaseUrl,
  validateBaseUrl,
} from "./firewall-types";
import { hasRawWhitespace, hasUnsafeUrlCodepoint } from "./firewall-url-utils";
import { parseSegment, splitPathSegments } from "./segment-parser";

type SegmentParseResult = ReturnType<typeof parseSegment>;
type MatchableSegment = Exclude<SegmentParseResult, { kind: "error" }>;
type SegmentMatchParser = (
  segment: string,
  patternIndex: number,
  lastPatternIndex: number,
) => MatchableSegment | null;

type PathSpecificity = readonly [
  literalSegments: number,
  mixedParamSegments: number,
  plainParamSegments: number,
  plusGreedySegments: number,
  negativeStarGreedySegments: number,
  literalChars: number,
  segmentCount: number,
];

export interface FindMatchingPermissionsOptions {
  apiBase?: string;
}

export interface FirewallBaseUrlMatch {
  displayBase: string;
  relativePath: string;
  score: number;
}

export interface FirewallRoutingPermissionRoute {
  readonly permissionName: string;
  readonly rule: string;
}

export interface FirewallRoutingPermissionApi {
  readonly base: string;
  readonly routes: readonly FirewallRoutingPermissionRoute[];
}

export type FirewallRequestBlockReason =
  | "permission_denied"
  | "unknown_endpoint"
  | "malformed_firewall_config"
  | "malformed_network_policy"
  | "unsafe_path";

export type FirewallConnectorIntent =
  | {
      readonly status: "absent" | "malformed";
    }
  | {
      readonly status: "present";
      readonly value: string;
    };

export type ConnectorRouteAmbiguityReason =
  | "connector_intent_required"
  | "malformed_connector_intent"
  | "connector_intent_not_candidate";

export type FirewallRequestDecision =
  | {
      readonly kind: "no_match";
    }
  | {
      readonly kind: "allow";
      readonly firewallName: string;
      readonly base: string;
      readonly relativePath: string;
      readonly permission?: string;
      readonly rule?: string;
    }
  | {
      readonly kind: "block";
      readonly firewallName: string;
      readonly base: string;
      readonly relativePath: string;
      readonly reason: FirewallRequestBlockReason;
      readonly permissions: readonly string[];
    }
  | {
      readonly kind: "ambiguous";
      readonly method: string;
      readonly path: string;
      readonly candidates: readonly string[];
      readonly reason: ConnectorRouteAmbiguityReason;
    };

interface ApiMatchState {
  bestSpecificity: PathSpecificity | null;
  matched: string[];
}

interface PermissionRuleSet {
  readonly name: string;
  readonly rules: readonly string[];
}

interface PermissionMatchApi {
  readonly permissionRuleSets: readonly PermissionRuleSet[];
}

type UnknownPolicy = "allow" | "deny" | "ask";

interface CompiledNetworkPolicy {
  readonly blockedPermissions: ReadonlySet<string>;
  readonly unknownPolicy: UnknownPolicy;
  readonly permissionMalformed: boolean;
  readonly unknownPolicyMalformed: boolean;
}

interface CompiledNetworkPolicies {
  readonly policies: ReadonlyMap<string, CompiledNetworkPolicy>;
  readonly topLevelMalformed: boolean;
}

interface DecisionRule {
  readonly permission: string;
  readonly raw: string;
  readonly method: string;
  readonly path: string;
  readonly specificity: PathSpecificity;
}

interface DecisionApi {
  readonly rawBase: string;
  readonly baseMalformed: boolean;
  readonly authMalformed: boolean;
  readonly hasMalformedRules: boolean;
  readonly permissionless: boolean;
  readonly routingIdentity: string | null;
  readonly rules: readonly DecisionRule[];
}

interface DecisionFirewall {
  readonly name: string;
  readonly intentIdentity: string;
  readonly nameMalformed: boolean;
  readonly apis: readonly DecisionApi[];
}

interface DecisionBaseMatch {
  readonly firewallName: string;
  readonly base: string;
  readonly allowBase: string;
  readonly relativePath: string;
}

interface DecisionAllowedRuleMatch {
  readonly firewallName: string;
  readonly base: string;
  readonly relativePath: string;
  readonly permission: string;
  readonly rule: string;
}

interface DecisionBlockMatch {
  readonly firewallName: string;
  readonly base: string;
  readonly relativePath: string;
}

interface FirewallDecisionState {
  bestBaseScore: number | null;
  bestRuleSpecificity: PathSpecificity | null;
  baseMatch: DecisionBaseMatch | null;
  allowedMatch: DecisionAllowedRuleMatch | null;
  deniedMatch: DecisionBlockMatch | null;
  deniedPermissionNames: string[];
  malformedConfigMatch: DecisionBlockMatch | null;
  malformedPolicyMatch: DecisionBlockMatch | null;
}

interface CollectedApiMatch {
  readonly order: number;
  readonly firewall: DecisionFirewall;
  readonly api: DecisionApi;
  readonly baseMatch: DecisionBaseMatch;
  readonly blockMatch: DecisionBlockMatch;
  readonly score: number;
}

interface CollectedRuleMatch {
  readonly apiMatch: CollectedApiMatch;
  readonly rule: DecisionRule;
}

interface FirewallMatchCollection {
  bestBaseScore: number | null;
  bestRuleSpecificity: PathSpecificity | null;
  apiMatches: CollectedApiMatch[];
  ruleMatches: CollectedRuleMatch[];
}

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
const FORBIDDEN_RUNTIME_HOST_CHARS = new Set("#%*,/<>?@\\^|{}".split(""));
const FORBIDDEN_BASE_PATTERN_HOST_CHARS = new Set("#%,/<>?@\\^|".split(""));
const PERCENT_ESCAPE_LENGTH = 3;
const HEX_DIGITS = new Set("0123456789abcdefABCDEF".split(""));
const PATH_SCORE_MULTIPLIER = 1_000_000;
const AUTHORITY_SCORE_MULTIPLIER = 100;
const LITERAL_SEGMENT_SCORE = 1_000;
const MIXED_PARAM_SEGMENT_SCORE = 100;
const PLAIN_PARAM_SEGMENT_SCORE = 10;
const PLUS_GREEDY_SEGMENT_SCORE = 1;
const ROOT_PATH_SCORE = 1;
const STATIC_BASE_SCORE_BONUS = 1;
const PERCENT_DECODED_AUTHORITY_SYNTAX_CHARS = new Set([
  "{",
  "}",
  "*",
  ".",
  "\u3002",
  "\uff0e",
  "\uff61",
  ":",
]);

/**
 * Match a runtime segment against a mixed pattern's literal prefix/suffix.
 *
 * Byte-exact comparison; callers must case-fold inputs themselves when
 * needed. Returns the captured middle on success, or null if prefix/suffix
 * don't match or the middle would be empty (non-empty guard).
 */
function matchMixedSegment(
  runtime: string,
  prefix: string,
  suffix: string,
): string | null {
  if (!runtime.startsWith(prefix)) return null;
  if (!runtime.endsWith(suffix)) return null;
  if (runtime.length <= prefix.length + suffix.length) return null;
  return runtime.slice(prefix.length, runtime.length - suffix.length);
}

function hasNonEmptySegment(segments: string[], start: number): boolean {
  for (let i = start; i < segments.length; i++) {
    if (segments[i] !== "") return true;
  }
  return false;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function hasUnsafeRuntimeUrlSyntax(value: string): boolean {
  return (
    hasUnsafeUrlCodepoint(value) ||
    hasRawWhitespace(value) ||
    value.includes("\\") ||
    !value.includes("://")
  );
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isInvalidGreedyParam(
  patternIndex: number,
  lastPatternIndex: number,
  prefix: string,
  suffix: string,
): boolean {
  return patternIndex !== lastPatternIndex || prefix !== "" || suffix !== "";
}

function parseStrictMatchSegment(
  segment: string,
  patternIndex: number,
  lastPatternIndex: number,
): MatchableSegment | null {
  const parsed = parseSegment(segment);
  if (parsed.kind === "error") return null;
  if (
    parsed.kind === "param" &&
    parsed.greedy !== "" &&
    isInvalidGreedyParam(
      patternIndex,
      lastPatternIndex,
      parsed.prefix,
      parsed.suffix,
    )
  ) {
    return null;
  }
  return parsed;
}

function pathSpecificity(pattern: string): PathSpecificity | null {
  if (
    !pattern.startsWith("/") ||
    pattern.includes("?") ||
    pattern.includes("#") ||
    pattern.includes("\\") ||
    hasRawWhitespace(pattern) ||
    hasUnsafeUrlCodepoint(pattern)
  ) {
    return null;
  }

  let literalSegments = 0;
  let mixedParamSegments = 0;
  let plainParamSegments = 0;
  let plusGreedySegments = 0;
  let starGreedySegments = 0;
  let literalChars = 0;
  const segments = splitPathSegments(pattern);
  const paramNames = new Set<string>();
  const lastSegmentIndex = segments.length - 1;

  for (let index = 0; index < segments.length; index += 1) {
    const seg = segments[index]!;
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") return null;
    if (parsed.kind === "literal") {
      literalSegments += 1;
      literalChars += codePointLength(parsed.value);
      continue;
    }
    if (paramNames.has(parsed.name)) return null;
    paramNames.add(parsed.name);
    if (
      parsed.greedy !== "" &&
      isInvalidGreedyParam(
        index,
        lastSegmentIndex,
        parsed.prefix,
        parsed.suffix,
      )
    ) {
      return null;
    }

    literalChars +=
      codePointLength(parsed.prefix) + codePointLength(parsed.suffix);
    if (parsed.prefix !== "" || parsed.suffix !== "") {
      mixedParamSegments += 1;
    } else if (parsed.greedy === "+") {
      plusGreedySegments += 1;
    } else if (parsed.greedy === "*") {
      starGreedySegments += 1;
    } else {
      plainParamSegments += 1;
    }
  }

  return [
    literalSegments,
    mixedParamSegments,
    plainParamSegments,
    plusGreedySegments,
    -starGreedySegments,
    literalChars,
    segments.length,
  ];
}

function comparePathSpecificity(
  left: PathSpecificity,
  right: PathSpecificity,
): number {
  for (let i = 0; i < left.length; i++) {
    const difference = left[i]! - right[i]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function matchingRulePath(rule: string, upperMethod: string): string | null {
  const spaceIdx = rule.indexOf(" ");
  if (spaceIdx === -1) return null;
  const ruleMethod = rule.slice(0, spaceIdx);
  if (!VALID_RULE_METHODS.has(ruleMethod)) return null;
  if (ruleMethod !== "ANY" && ruleMethod !== upperMethod) return null;
  return rule.slice(spaceIdx + 1);
}

function compileDecisionRule(
  permission: string,
  rule: string,
): DecisionRule | null {
  const spaceIdx = rule.indexOf(" ");
  if (spaceIdx === -1) return null;
  const method = rule.slice(0, spaceIdx);
  if (!VALID_RULE_METHODS.has(method)) return null;
  const path = rule.slice(spaceIdx + 1);
  const specificity = pathSpecificity(path);
  if (specificity === null) return null;
  return { permission, raw: rule, method, path, specificity };
}

function isValidPermissionName(permissionName: string): boolean {
  return permissionName !== "" && permissionName !== "all";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isObjectRecord(value)) return false;
  return Object.values(value).every((entry) => {
    return typeof entry === "string";
  });
}

function hasEntries(value: Record<string, string> | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function isValidAwsSigv4AuthConfig(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  const allowedKeys = new Set([
    "accessKeyId",
    "secretAccessKey",
    "sessionToken",
  ]);
  if (
    Object.keys(value).some((key) => {
      return !allowedKeys.has(key);
    })
  ) {
    return false;
  }
  if (typeof value.accessKeyId !== "string" || value.accessKeyId === "") {
    return false;
  }
  if (
    typeof value.secretAccessKey !== "string" ||
    value.secretAccessKey === ""
  ) {
    return false;
  }
  const optionalValue = value.sessionToken;
  if (
    optionalValue !== undefined &&
    (typeof optionalValue !== "string" || optionalValue === "")
  ) {
    return false;
  }
  return true;
}

function isValidAuthConfig(auth: unknown, serviceName: string): boolean {
  if (!isObjectRecord(auth)) return false;
  if (auth.headers !== undefined && !isStringRecord(auth.headers)) return false;
  if (auth.query !== undefined && !isStringRecord(auth.query)) return false;
  if (
    auth.awsSigv4 !== undefined &&
    !isValidAwsSigv4AuthConfig(auth.awsSigv4)
  ) {
    return false;
  }
  if (auth.awsSigv4 !== undefined) {
    if (hasEntries(auth.headers as Record<string, string> | undefined)) {
      return false;
    }
    if (hasEntries(auth.query as Record<string, string> | undefined)) {
      return false;
    }
  }
  if (auth.base !== undefined) {
    if (typeof auth.base !== "string") return false;
    validateAuthBaseUrl(auth.base, serviceName);
    if (auth.awsSigv4 !== undefined) return false;
  }
  return true;
}

function isValidApiEntry(
  api: FirewallConfig["apis"][number],
  serviceName: string,
): boolean {
  if (!isObjectRecord(api)) return false;
  if (typeof api.base !== "string") return false;
  try {
    validateBaseUrl(api.base, serviceName);
    if (!isValidAuthConfig(api.auth, serviceName)) return false;
  } catch {
    return false;
  }
  return true;
}

function getPermissionName(permission: unknown): string | null {
  if (!isObjectRecord(permission)) return null;
  if (typeof permission.name !== "string") return null;
  if (!isValidPermissionName(permission.name)) return null;
  return permission.name;
}

function getPermissionRules(permission: unknown): string[] {
  if (!isObjectRecord(permission)) return [];
  if (!Array.isArray(permission.rules)) return [];
  const rules = permission.rules.filter((rule) => {
    return typeof rule === "string";
  });
  return rules;
}

function rawObjectHasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidAuthConfigForDecision(
  auth: unknown,
  serviceName: string,
): boolean {
  try {
    return isValidAuthConfig(auth, serviceName);
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const encoded = canonicalJson(item);
      if (encoded === undefined) return undefined;
      items.push(encoded);
    }
    return `[${items.join(",")}]`;
  }
  if (!isObjectRecord(value)) return undefined;

  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) continue;
    const encoded = canonicalJson(item);
    if (encoded === undefined) return undefined;
    entries.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${entries.join(",")}}`;
}

function decisionApiRoutingIdentity(
  api: Record<string, unknown>,
): string | null {
  return (
    canonicalJson({
      base: api.base,
      hostPolicy: api.hostPolicy,
      auth: api.auth,
    }) ?? null
  );
}

function compileDecisionApi(
  api: Record<string, unknown>,
  serviceName: string,
  nameMalformed: boolean,
): DecisionApi | null {
  if (typeof api.base !== "string") return null;

  let baseMalformed = false;
  try {
    validateBaseUrl(api.base, serviceName);
  } catch {
    baseMalformed = true;
  }
  const authMalformed = !isValidAuthConfigForDecision(api.auth, serviceName);
  const routingIdentity = decisionApiRoutingIdentity(api);
  const rules: DecisionRule[] = [];
  const seenPermissionNames = new Set<string>();
  let hasMalformedRules = nameMalformed;
  const rawPermissions = api.permissions;
  const permissionless =
    !rawObjectHasOwn(api, "permissions") ||
    (Array.isArray(rawPermissions) && rawPermissions.length === 0);

  if (Array.isArray(rawPermissions)) {
    for (const rawPermission of rawPermissions) {
      if (!isObjectRecord(rawPermission)) {
        hasMalformedRules = true;
        continue;
      }
      const permissionName = rawPermission.name;
      if (
        typeof permissionName !== "string" ||
        !isValidPermissionName(permissionName)
      ) {
        hasMalformedRules = true;
        continue;
      }
      if (seenPermissionNames.has(permissionName)) {
        hasMalformedRules = true;
        continue;
      }
      seenPermissionNames.add(permissionName);

      const rawRules = rawPermission.rules;
      if (!Array.isArray(rawRules)) {
        hasMalformedRules = true;
        continue;
      }
      if (rawRules.length === 0) {
        hasMalformedRules = true;
      }

      for (const rawRule of rawRules) {
        if (typeof rawRule !== "string") {
          hasMalformedRules = true;
          continue;
        }
        const compiledRule = compileDecisionRule(permissionName, rawRule);
        if (compiledRule === null) {
          hasMalformedRules = true;
          continue;
        }
        rules.push(compiledRule);
      }
    }
  } else if (rawObjectHasOwn(api, "permissions")) {
    hasMalformedRules = true;
  }

  return {
    rawBase: api.base,
    baseMalformed,
    authMalformed,
    hasMalformedRules,
    permissionless,
    routingIdentity,
    rules,
  };
}

function compileDecisionFirewall(
  rawFirewall: unknown,
): DecisionFirewall | null {
  if (!isObjectRecord(rawFirewall)) return null;

  const rawName = rawFirewall.name;
  const nameMalformed = typeof rawName !== "string" || rawName === "";
  const name = typeof rawName === "string" ? rawName : "";
  const rawCustomConnectorId = rawFirewall.customConnectorId;
  const intentIdentity =
    typeof rawCustomConnectorId === "string" && rawCustomConnectorId !== ""
      ? rawCustomConnectorId
      : name;
  const rawApis = rawFirewall.apis;
  if (!Array.isArray(rawApis)) return null;

  const apis: DecisionApi[] = [];
  for (const rawApi of rawApis) {
    if (!isObjectRecord(rawApi)) continue;
    const api = compileDecisionApi(rawApi, name, nameMalformed);
    if (api !== null) {
      apis.push(api);
    }
  }

  if (apis.length === 0) return null;
  return { name, intentIdentity, nameMalformed, apis };
}

function compileDecisionFirewalls(rawFirewalls: unknown): DecisionFirewall[] {
  if (!Array.isArray(rawFirewalls) || rawFirewalls.length === 0) return [];

  const firewalls: DecisionFirewall[] = [];
  for (const rawFirewall of rawFirewalls) {
    const firewall = compileDecisionFirewall(rawFirewall);
    if (firewall !== null) {
      firewalls.push(firewall);
    }
  }
  return firewalls;
}

function compilePermissionSet(rawValue: unknown): {
  readonly values: ReadonlySet<string>;
  readonly malformed: boolean;
} {
  if (rawValue === undefined || rawValue === null) {
    return { values: new Set<string>(), malformed: false };
  }
  if (
    !Array.isArray(rawValue) ||
    rawValue.some((item) => {
      return typeof item !== "string";
    })
  ) {
    return { values: new Set<string>(), malformed: true };
  }
  return { values: new Set(rawValue), malformed: false };
}

function compileNetworkPolicies(
  rawNetworkPolicies: unknown,
): CompiledNetworkPolicies {
  if (rawNetworkPolicies === undefined || rawNetworkPolicies === null) {
    return { policies: new Map(), topLevelMalformed: false };
  }
  if (!isObjectRecord(rawNetworkPolicies)) {
    return { policies: new Map(), topLevelMalformed: true };
  }

  const policies = new Map<string, CompiledNetworkPolicy>();
  for (const [firewallName, grant] of Object.entries(rawNetworkPolicies)) {
    if (!isObjectRecord(grant)) {
      policies.set(firewallName, {
        blockedPermissions: new Set<string>(),
        unknownPolicy: "allow",
        permissionMalformed: true,
        unknownPolicyMalformed: false,
      });
      continue;
    }

    const allow = compilePermissionSet(grant.allow);
    const deny = compilePermissionSet(grant.deny);
    const ask = compilePermissionSet(grant.ask);
    const blockedPermissions = new Set<string>([...deny.values, ...ask.values]);

    let unknownPolicy: UnknownPolicy = "allow";
    let unknownPolicyMalformed = false;
    const rawUnknownPolicy = grant.unknownPolicy;
    if (
      rawUnknownPolicy === "allow" ||
      rawUnknownPolicy === "deny" ||
      rawUnknownPolicy === "ask"
    ) {
      unknownPolicy = rawUnknownPolicy;
    } else if (rawUnknownPolicy !== undefined && rawUnknownPolicy !== null) {
      unknownPolicyMalformed = true;
    }

    policies.set(firewallName, {
      blockedPermissions,
      unknownPolicy,
      permissionMalformed: allow.malformed || deny.malformed || ask.malformed,
      unknownPolicyMalformed,
    });
  }

  return { policies, topLevelMalformed: false };
}

function getApiPermissionRuleSetsForMatch(
  api: FirewallConfig["apis"][number],
  serviceName: string,
  apiBase: string | null,
): PermissionRuleSet[] | null {
  if (!isValidApiEntry(api, serviceName)) return null;
  if (apiBase !== null && stripTrailingSlash(api.base) !== apiBase) return null;
  if (api.permissions === undefined) return null;
  if (!Array.isArray(api.permissions)) return null;

  const permissionRuleSets: PermissionRuleSet[] = [];
  const seenPermissionNames = new Set<string>();
  for (const rawPermission of api.permissions) {
    const permissionName = getPermissionName(rawPermission);
    if (permissionName === null) continue;
    if (seenPermissionNames.has(permissionName)) continue;
    seenPermissionNames.add(permissionName);
    permissionRuleSets.push({
      name: permissionName,
      rules: getPermissionRules(rawPermission),
    });
  }
  return permissionRuleSets;
}

function recordPermissionMatch(
  state: ApiMatchState,
  permission: string,
  specificity: PathSpecificity,
): void {
  if (
    state.bestSpecificity === null ||
    comparePathSpecificity(specificity, state.bestSpecificity) > 0
  ) {
    state.bestSpecificity = specificity;
    state.matched.length = 0;
  }
  if (
    comparePathSpecificity(specificity, state.bestSpecificity) === 0 &&
    !state.matched.includes(permission)
  ) {
    state.matched.push(permission);
  }
}

function relativePathFromSegments(
  segments: string[],
  consumed: number,
): string {
  const rest = segments.slice(consumed).join("/");
  return rest === "" ? "/" : `/${rest}`;
}

function stripUrlQueryAndFragment(url: string): string {
  const queryIndex = url.indexOf("?");
  const fragmentIndex = url.indexOf("#");
  let end = url.length;
  if (queryIndex !== -1) end = Math.min(end, queryIndex);
  if (fragmentIndex !== -1) end = Math.min(end, fragmentIndex);
  return url.slice(0, end);
}

function rawUrlAuthorityBounds(url: string): {
  readonly authorityStart: number;
  readonly authorityEnd: number;
} | null {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return null;

  const authorityStart = schemeEnd + 3;
  let authorityEnd = url.length;
  for (const delimiter of ["/", "?", "#"]) {
    const delimiterIndex = url.indexOf(delimiter, authorityStart);
    if (delimiterIndex !== -1)
      authorityEnd = Math.min(authorityEnd, delimiterIndex);
  }

  return { authorityStart, authorityEnd };
}

function replaceRawUrlAuthority(
  url: string,
  bounds: { readonly authorityStart: number; readonly authorityEnd: number },
  authority: string,
): string {
  return `${url.slice(0, bounds.authorityStart)}${authority}${url.slice(bounds.authorityEnd)}`;
}

function stripRawUrlUserinfo(url: string): string {
  const bounds = rawUrlAuthorityBounds(url);
  if (bounds === null) return url;

  const authority = url.slice(bounds.authorityStart, bounds.authorityEnd);
  const userinfoEnd = authority.lastIndexOf("@");
  if (userinfoEnd === -1) return url;

  return replaceRawUrlAuthority(url, bounds, authority.slice(userinfoEnd + 1));
}

function rawAuthorityPortIsMalformed(port: string): boolean {
  if (port === "") return true;
  if (
    ![...port].every((char) => {
      return char >= "0" && char <= "9";
    })
  ) {
    return true;
  }
  return Number(port) > 65535;
}

function stripRawUrlMalformedPort(url: string): string {
  const bounds = rawUrlAuthorityBounds(url);
  if (bounds === null) return url;

  const authority = url.slice(bounds.authorityStart, bounds.authorityEnd);
  if (authority.startsWith("[")) {
    const closeBracketIndex = authority.indexOf("]");
    if (closeBracketIndex === -1) return url;
    const portPrefix = authority.slice(closeBracketIndex + 1);
    if (!portPrefix.startsWith(":")) return url;
    if (!rawAuthorityPortIsMalformed(portPrefix.slice(1))) return url;
    return replaceRawUrlAuthority(
      url,
      bounds,
      authority.slice(0, closeBracketIndex + 1),
    );
  }

  const portSeparator = authority.lastIndexOf(":");
  if (portSeparator === -1) return url;
  if (authority.indexOf(":") !== portSeparator) return url;
  if (!rawAuthorityPortIsMalformed(authority.slice(portSeparator + 1))) {
    return url;
  }
  return replaceRawUrlAuthority(url, bounds, authority.slice(0, portSeparator));
}

function rawBaseForDecisionMatch(rawBase: string): string | null {
  if (stripUrlQueryAndFragment(rawBase).includes("\\")) return null;
  return stripRawUrlMalformedPort(stripRawUrlUserinfo(rawBase));
}

function rawPathFromUrl(url: string): string {
  const urlWithoutQuery = stripUrlQueryAndFragment(url);
  const schemeEnd = urlWithoutQuery.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = urlWithoutQuery.indexOf("/", authorityStart);
  return pathStart === -1 ? "/" : urlWithoutQuery.slice(pathStart);
}

function rawBasePathFromUrl(url: string): string {
  const urlWithoutQuery = stripUrlQueryAndFragment(url);
  const schemeEnd = urlWithoutQuery.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = urlWithoutQuery.indexOf("/", authorityStart);
  return pathStart === -1 ? "" : urlWithoutQuery.slice(pathStart);
}

function rawAuthorityFromUrl(url: string): string | null {
  const urlWithoutQuery = stripUrlQueryAndFragment(url);
  const schemeEnd = urlWithoutQuery.indexOf("://");
  if (schemeEnd === -1) return null;
  const authorityStart = schemeEnd + 3;
  const pathStart = urlWithoutQuery.indexOf("/", authorityStart);
  const authority =
    pathStart === -1
      ? urlWithoutQuery.slice(authorityStart)
      : urlWithoutQuery.slice(authorityStart, pathStart);
  return authority === "" ? null : authority;
}

function hasNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return true;
  }
  return false;
}

function rawHostFromAuthority(authority: string): string {
  const withoutUserinfo = authority.slice(authority.lastIndexOf("@") + 1);
  if (withoutUserinfo.startsWith("[")) {
    const closeBracket = withoutUserinfo.indexOf("]");
    return closeBracket === -1
      ? withoutUserinfo
      : withoutUserinfo.slice(0, closeBracket + 1);
  }
  const portSeparator = withoutUserinfo.lastIndexOf(":");
  return portSeparator === -1
    ? withoutUserinfo
    : withoutUserinfo.slice(0, portSeparator);
}

function authorityHasEmptyPort(authority: string): boolean {
  const withoutUserinfo = authority.slice(authority.lastIndexOf("@") + 1);
  if (withoutUserinfo.startsWith("[")) {
    const closeBracket = withoutUserinfo.indexOf("]");
    if (closeBracket === -1) return false;
    return withoutUserinfo.slice(closeBracket + 1) === ":";
  }

  const portSeparator = withoutUserinfo.lastIndexOf(":");
  if (portSeparator === -1) return false;
  return (
    withoutUserinfo.indexOf(":") === portSeparator &&
    portSeparator === withoutUserinfo.length - 1
  );
}

function rawAuthorityHostStartsWithDigit(authority: string): boolean {
  const firstChar = rawHostFromAuthority(authority)[0];
  return firstChar !== undefined && firstChar >= "0" && firstChar <= "9";
}

function runtimeAuthorityOriginForHostValidation(url: string): string | null {
  const authority = rawAuthorityFromUrl(url);
  if (authority === null) return null;
  if (
    !authority.includes("%") &&
    !hasNonAscii(authority) &&
    !rawAuthorityHostStartsWithDigit(authority)
  ) {
    return null;
  }

  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return null;
  return `${url.slice(0, schemeEnd)}://${authority}`;
}

function hasPercentEncodedAuthoritySyntax(value: string): boolean {
  let index = value.indexOf("%");
  while (index !== -1) {
    let runEnd = index;
    while (runEnd < value.length && value[runEnd] === "%") {
      const firstHexDigit = value[runEnd + 1];
      const secondHexDigit = value[runEnd + 2];
      if (
        !firstHexDigit ||
        !secondHexDigit ||
        !HEX_DIGITS.has(firstHexDigit) ||
        !HEX_DIGITS.has(secondHexDigit)
      ) {
        return true;
      }
      runEnd += PERCENT_ESCAPE_LENGTH;
    }

    let decodedRun: string;
    try {
      decodedRun = decodeURIComponent(value.slice(index, runEnd));
    } catch {
      return true;
    }
    for (const char of decodedRun) {
      if (PERCENT_DECODED_AUTHORITY_SYNTAX_CHARS.has(char)) {
        return true;
      }
    }
    index = value.indexOf("%", runEnd);
  }
  return false;
}

function hasMalformedRuntimeAuthoritySyntax(url: string): boolean {
  const authority = rawAuthorityFromUrl(url);
  if (authority === null) return false;
  return (
    authority.includes("\\") ||
    authorityHasEmptyPort(authority) ||
    hasPercentEncodedAuthoritySyntax(authority)
  );
}

function scoreLiteralSegment(segment: string): number {
  return LITERAL_SEGMENT_SCORE + codePointLength(segment);
}

function scoreParsedPatternSegment(parsed: MatchableSegment): number {
  if (parsed.kind === "literal") {
    return scoreLiteralSegment(parsed.value);
  }

  const literalChars =
    codePointLength(parsed.prefix) + codePointLength(parsed.suffix);
  if (parsed.prefix !== "" || parsed.suffix !== "") {
    return MIXED_PARAM_SEGMENT_SCORE + literalChars;
  }
  if (parsed.greedy === "+") return PLUS_GREEDY_SEGMENT_SCORE;
  if (parsed.greedy === "*") return 0;
  return PLAIN_PARAM_SEGMENT_SCORE;
}

function scoreStaticSegments(segments: string[]): number {
  return segments.reduce((score, segment) => {
    return score + scoreLiteralSegment(segment);
  }, 0);
}

function scorePatternSegmentsWithParser(
  segments: string[],
  parsePatternSegment: SegmentMatchParser,
): number {
  const lastPatternIndex = segments.length - 1;
  let score = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const parsed = parsePatternSegment(segment, index, lastPatternIndex);
    if (parsed !== null) {
      score += scoreParsedPatternSegment(parsed);
    }
  }
  return score;
}

function scorePathPattern(
  path: string,
  parsePatternSegment: SegmentMatchParser | null,
): number {
  if (path === "") return 0;
  if (path === "/") return ROOT_PATH_SCORE;
  const segments = splitPathSegments(path);
  return parsePatternSegment === null
    ? scoreStaticSegments(segments)
    : scorePatternSegmentsWithParser(segments, parsePatternSegment);
}

function splitAuthoritySegments(authority: string): string[] {
  if (authority.startsWith("[")) return [authority];
  const normalized = authority.endsWith(".")
    ? authority.slice(0, -1)
    : authority;
  return normalized === "" ? [] : normalized.split(".");
}

function baseUrlSpecificityScore({
  authority,
  path,
  hasParams,
  tolerateMalformedBaseParams = false,
}: {
  readonly authority: string;
  readonly path: string;
  readonly hasParams: boolean;
  readonly tolerateMalformedBaseParams?: boolean;
}): number {
  const patternParser = hasParams
    ? tolerateMalformedBaseParams
      ? parseMalformedTolerantBaseSegment
      : parseStrictMatchSegment
    : null;
  const authoritySegments = splitAuthoritySegments(authority);
  const authorityScore =
    patternParser === null
      ? scoreStaticSegments(authoritySegments)
      : scorePatternSegmentsWithParser(
          [...authoritySegments].reverse(),
          patternParser,
        );
  const pathScore = scorePathPattern(path, patternParser);
  return (
    pathScore * PATH_SCORE_MULTIPLIER +
    authorityScore * AUTHORITY_SCORE_MULTIPLIER +
    (hasParams ? 0 : STATIC_BASE_SCORE_BONUS)
  );
}

function matchStaticBasePathPrefix(
  path: string,
  pattern: string,
): string | null {
  if (pattern === "") {
    return path === "" ? "/" : path;
  }
  if (pattern === "/") {
    if (!path.startsWith(pattern)) return null;
    const relativePath = path.slice(pattern.length);
    if (relativePath !== "" && !relativePath.startsWith("/")) return null;
    return relativePath === "" ? "/" : relativePath;
  }
  if (!path.startsWith(pattern)) return null;
  const relativePath = path.slice(pattern.length);
  if (relativePath !== "" && !relativePath.startsWith("/")) return null;
  return relativePath === "" ? "/" : relativePath;
}

function normalizeUrlHostname(
  hostname: string,
  options: { allowHostParams?: boolean } = {},
): string | null {
  let normalized = hostname.toLowerCase();
  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
    if (normalized === "" || normalized.endsWith(".")) {
      return null;
    }
  }
  if (
    normalized.split(".").some((label) => {
      return label === "";
    })
  ) {
    return null;
  }
  const forbiddenChars =
    options.allowHostParams === true
      ? FORBIDDEN_BASE_PATTERN_HOST_CHARS
      : FORBIDDEN_RUNTIME_HOST_CHARS;
  if (
    !normalized.startsWith("[") &&
    [...normalized].some((char) => {
      return forbiddenChars.has(char);
    })
  ) {
    return null;
  }
  return normalized;
}

interface NormalizedUrlAuthority {
  readonly hostname: string;
  readonly port: string | null;
  readonly authority: string;
}

function normalizedUrlAuthority(
  parsed: URL,
  options: { allowHostParams?: boolean } = {},
): NormalizedUrlAuthority | null {
  if (parsed.username !== "" || parsed.password !== "") {
    return null;
  }

  const hostname = normalizeUrlHostname(parsed.hostname, options);
  if (hostname === null || hostname === "") {
    return null;
  }

  const port = parsed.port === "" ? null : parsed.port;
  return {
    hostname,
    port,
    authority: port === null ? hostname : `${hostname}:${port}`,
  };
}

function matchStaticFirewallBaseUrl(
  url: string,
  rawBase: string,
  options: {
    readonly tolerateMalformedBaseParams?: boolean;
  } = {},
): FirewallBaseUrlMatch | null {
  const parsedUrl = new URL(url);
  const parsedBase = new URL(rawBase);
  if (parsedUrl.protocol.toLowerCase() !== parsedBase.protocol.toLowerCase()) {
    return null;
  }
  const baseHasParams = hasBaseUrlParams(rawBase);
  const baseForMatch = stripTrailingSlash(rawBase);

  const urlAuthority = normalizedUrlAuthority(parsedUrl);
  const baseAuthority = normalizedUrlAuthority(parsedBase, {
    allowHostParams: baseHasParams,
  });
  if (urlAuthority === null || baseAuthority === null) return null;
  if (baseHasParams) {
    if (urlAuthority.port !== baseAuthority.port) return null;
    const hostParams =
      options.tolerateMalformedBaseParams === true
        ? matchFirewallHostForMalformedBaseDecision(
            urlAuthority.hostname,
            baseAuthority.hostname,
          )
        : matchFirewallHost(urlAuthority.hostname, baseAuthority.hostname);
    if (hostParams === null) return null;
  } else if (urlAuthority.authority !== baseAuthority.authority) {
    return null;
  }

  const basePath = rawBasePathFromUrl(baseForMatch);
  const relativePath = baseHasParams
    ? options.tolerateMalformedBaseParams === true
      ? matchFirewallPathPrefixForMalformedBaseDecision(
          rawPathFromUrl(url),
          basePath,
        )
      : matchFirewallPathPrefix(rawPathFromUrl(url), basePath)
    : matchStaticBasePathPrefix(rawPathFromUrl(url), basePath);
  if (relativePath === null) return null;

  const displayBase = stripTrailingSlash(rawBase);
  return {
    displayBase,
    relativePath,
    score: baseUrlSpecificityScore({
      authority: baseHasParams
        ? baseAuthority.hostname
        : baseAuthority.authority,
      path: basePath,
      hasParams: baseHasParams,
      tolerateMalformedBaseParams: options.tolerateMalformedBaseParams === true,
    }),
  };
}

function runtimeUrlCanMatchFirewallBase(url: string): boolean {
  if (
    hasUnsafeUrlCodepoint(url) ||
    hasRawWhitespace(url) ||
    !url.includes("://") ||
    hasMalformedRuntimeAuthoritySyntax(url)
  ) {
    return false;
  }

  const runtimeAuthorityOrigin = runtimeAuthorityOriginForHostValidation(url);
  if (runtimeAuthorityOrigin === null) return true;

  try {
    validateBaseUrl(runtimeAuthorityOrigin, "runtime");
    return true;
  } catch {
    return false;
  }
}

function matchFirewallBaseUrlForDecision(
  url: string,
  rawBase: string,
): FirewallBaseUrlMatch | null {
  if (!runtimeUrlCanMatchFirewallBase(url)) return null;
  const baseForMatch = rawBaseForDecisionMatch(rawBase);
  if (baseForMatch === null) return null;

  try {
    const match = matchStaticFirewallBaseUrl(url, baseForMatch, {
      tolerateMalformedBaseParams: true,
    });
    if (match === null) return null;
    return { ...match, displayBase: stripTrailingSlash(rawBase) };
  } catch {
    return null;
  }
}

function createDecisionState(): FirewallDecisionState {
  return {
    bestBaseScore: null,
    bestRuleSpecificity: null,
    baseMatch: null,
    allowedMatch: null,
    deniedMatch: null,
    deniedPermissionNames: [],
    malformedConfigMatch: null,
    malformedPolicyMatch: null,
  };
}

function acceptDecisionBaseMatch(
  state: FirewallDecisionState,
  match: DecisionBaseMatch,
  score: number,
): boolean {
  if (state.bestBaseScore === null || score > state.bestBaseScore) {
    state.bestBaseScore = score;
    state.bestRuleSpecificity = null;
    state.baseMatch = null;
    state.allowedMatch = null;
    state.deniedMatch = null;
    state.deniedPermissionNames = [];
    state.malformedConfigMatch = null;
    state.malformedPolicyMatch = null;
  } else if (score < state.bestBaseScore) {
    return false;
  }

  state.baseMatch ??= match;
  return true;
}

function acceptRuleSpecificity(
  state: FirewallDecisionState,
  specificity: PathSpecificity,
): boolean {
  if (state.bestRuleSpecificity === null) {
    state.bestRuleSpecificity = specificity;
    return true;
  }

  const comparison = comparePathSpecificity(
    specificity,
    state.bestRuleSpecificity,
  );
  if (comparison > 0) {
    state.bestRuleSpecificity = specificity;
    state.allowedMatch = null;
    state.deniedMatch = null;
    state.deniedPermissionNames = [];
    return true;
  }
  return comparison === 0;
}

function recordDeniedRule(
  state: FirewallDecisionState,
  match: DecisionBlockMatch,
  permission: string,
): void {
  if (!state.deniedPermissionNames.includes(permission)) {
    state.deniedPermissionNames.push(permission);
  }
  state.deniedMatch ??= match;
}

function resolveFirewallDecision(
  state: FirewallDecisionState,
  networkPolicies: CompiledNetworkPolicies,
): FirewallRequestDecision {
  const baseMatch = state.baseMatch;
  if (baseMatch === null) {
    return { kind: "no_match" };
  }

  if (state.allowedMatch !== null) {
    return {
      kind: "allow",
      firewallName: state.allowedMatch.firewallName,
      base: state.allowedMatch.base,
      relativePath: state.allowedMatch.relativePath,
      permission: state.allowedMatch.permission,
      rule: state.allowedMatch.rule,
    };
  }

  if (state.deniedMatch !== null) {
    return {
      kind: "block",
      firewallName: state.deniedMatch.firewallName,
      base: state.deniedMatch.base,
      relativePath: state.deniedMatch.relativePath,
      reason: "permission_denied",
      permissions: state.deniedPermissionNames,
    };
  }

  if (state.malformedPolicyMatch !== null) {
    return {
      kind: "block",
      firewallName: state.malformedPolicyMatch.firewallName,
      base: state.malformedPolicyMatch.base,
      relativePath: state.malformedPolicyMatch.relativePath,
      reason: "malformed_network_policy",
      permissions: [],
    };
  }

  if (state.malformedConfigMatch !== null) {
    return {
      kind: "block",
      firewallName: state.malformedConfigMatch.firewallName,
      base: state.malformedConfigMatch.base,
      relativePath: state.malformedConfigMatch.relativePath,
      reason: "malformed_firewall_config",
      permissions: [],
    };
  }

  const policy = networkPolicies.policies.get(baseMatch.firewallName);
  if (policy === undefined) {
    return {
      kind: "allow",
      firewallName: baseMatch.firewallName,
      base: baseMatch.allowBase,
      relativePath: baseMatch.relativePath,
    };
  }
  if (policy.unknownPolicyMalformed) {
    return {
      kind: "block",
      firewallName: baseMatch.firewallName,
      base: baseMatch.base,
      relativePath: baseMatch.relativePath,
      reason: "malformed_network_policy",
      permissions: [],
    };
  }
  if (policy.unknownPolicy === "allow") {
    return {
      kind: "allow",
      firewallName: baseMatch.firewallName,
      base: baseMatch.allowBase,
      relativePath: baseMatch.relativePath,
    };
  }

  return {
    kind: "block",
    firewallName: baseMatch.firewallName,
    base: baseMatch.base,
    relativePath: baseMatch.relativePath,
    reason: "unknown_endpoint",
    permissions: [],
  };
}

function unsafePathBlockDecision(
  firewall: DecisionFirewall,
  baseMatch: FirewallBaseUrlMatch,
): FirewallRequestDecision {
  return {
    kind: "block",
    firewallName: firewall.name,
    base: baseMatch.displayBase,
    relativePath: baseMatch.relativePath,
    reason: "unsafe_path",
    permissions: [],
  };
}

function recordMalformedDecisionState(
  state: FirewallDecisionState,
  api: DecisionApi,
  blockMatch: DecisionBlockMatch,
): void {
  if (
    api.baseMalformed ||
    api.authMalformed ||
    api.hasMalformedRules ||
    api.routingIdentity === null
  ) {
    state.malformedConfigMatch ??= blockMatch;
  }
}

function apiCannotEvaluateRules(
  firewall: DecisionFirewall,
  api: DecisionApi,
): boolean {
  return (
    firewall.nameMalformed ||
    api.baseMalformed ||
    api.authMalformed ||
    api.routingIdentity === null
  );
}

function policyCannotEvaluateRules(
  networkPolicies: CompiledNetworkPolicies,
  policy: CompiledNetworkPolicy | undefined,
): boolean {
  return (
    networkPolicies.topLevelMalformed ||
    (policy !== undefined && policy.permissionMalformed)
  );
}

function createMatchCollection(): FirewallMatchCollection {
  return {
    bestBaseScore: null,
    bestRuleSpecificity: null,
    apiMatches: [],
    ruleMatches: [],
  };
}

function acceptCollectedApi(
  collection: FirewallMatchCollection,
  match: CollectedApiMatch,
): boolean {
  if (
    collection.bestBaseScore === null ||
    match.score > collection.bestBaseScore
  ) {
    collection.bestBaseScore = match.score;
    collection.bestRuleSpecificity = null;
    collection.apiMatches = [];
    collection.ruleMatches = [];
  } else if (match.score < collection.bestBaseScore) {
    return false;
  }
  collection.apiMatches.push(match);
  return true;
}

function canRuleAffectCollection(
  collection: FirewallMatchCollection,
  specificity: PathSpecificity,
): boolean {
  if (collection.bestRuleSpecificity === null) return true;
  return (
    comparePathSpecificity(specificity, collection.bestRuleSpecificity) >= 0
  );
}

function recordCollectedRule(
  collection: FirewallMatchCollection,
  match: CollectedRuleMatch,
): void {
  const bestSpecificity = collection.bestRuleSpecificity;
  if (
    bestSpecificity === null ||
    comparePathSpecificity(match.rule.specificity, bestSpecificity) > 0
  ) {
    collection.bestRuleSpecificity = match.rule.specificity;
    collection.ruleMatches = [];
  } else if (
    comparePathSpecificity(match.rule.specificity, bestSpecificity) < 0
  ) {
    return;
  }
  collection.ruleMatches.push(match);
}

function collectDecisionRules(
  collection: FirewallMatchCollection,
  apiMatch: CollectedApiMatch,
  upperMethod: string,
): void {
  for (const rule of apiMatch.api.rules) {
    if (rule.method !== "ANY" && rule.method !== upperMethod) continue;
    if (!canRuleAffectCollection(collection, rule.specificity)) continue;
    if (
      matchFirewallPath(apiMatch.baseMatch.relativePath, rule.path) === null
    ) {
      continue;
    }
    recordCollectedRule(collection, { apiMatch, rule });
  }
}

function winningApiMatches(
  collection: FirewallMatchCollection,
): CollectedApiMatch[] {
  if (collection.ruleMatches.length === 0) {
    return collection.apiMatches;
  }

  const matches: CollectedApiMatch[] = [];
  const seenOrders = new Set<number>();
  for (const ruleMatch of collection.ruleMatches) {
    if (seenOrders.has(ruleMatch.apiMatch.order)) continue;
    seenOrders.add(ruleMatch.apiMatch.order);
    matches.push(ruleMatch.apiMatch);
  }
  return matches;
}

function winningOwnerNames(
  collection: FirewallMatchCollection,
): readonly string[] {
  const names = new Set<string>();
  for (const apiMatch of winningApiMatches(collection)) {
    if (!apiMatch.firewall.nameMalformed) {
      names.add(apiMatch.firewall.name);
    }
  }
  return [...names].sort();
}

function ownerNameForIntent(
  collection: FirewallMatchCollection,
  intentValue: string,
): string | null {
  const names = new Set<string>();
  for (const apiMatch of winningApiMatches(collection)) {
    if (
      !apiMatch.firewall.nameMalformed &&
      apiMatch.firewall.intentIdentity === intentValue
    ) {
      names.add(apiMatch.firewall.name);
    }
  }
  if (names.size !== 1) return null;
  return names.values().next().value ?? null;
}

function selectedOwnerApiMatches(
  collection: FirewallMatchCollection,
  selectedName: string,
): CollectedApiMatch[] {
  const matches = winningApiMatches(collection).filter((match) => {
    return match.firewall.name === selectedName;
  });
  if (collection.ruleMatches.length > 0) return matches;

  // APIs without permissions are catch-alls only within the selected owner.
  // Owner selection must still resolve shared bases before this fallback.
  const permissionlessMatches = matches.filter((match) => {
    return match.api.permissionless;
  });
  return permissionlessMatches.length > 0 ? permissionlessMatches : matches;
}

function relevantOwnerApiMatches(
  collection: FirewallMatchCollection,
  selectedName: string | null,
): readonly CollectedApiMatch[] {
  if (selectedName === null) return collection.apiMatches;
  return collection.apiMatches.filter((match) => {
    return match.firewall.name === selectedName || match.firewall.nameMalformed;
  });
}

function selectedBaseApiMatches(
  collection: FirewallMatchCollection,
  selectedName: string | null,
): readonly CollectedApiMatch[] {
  const relevantMatches = relevantOwnerApiMatches(collection, selectedName);
  if (selectedName === null || collection.ruleMatches.length > 0) {
    return relevantMatches;
  }

  const selectedOrders = new Set(
    selectedOwnerApiMatches(collection, selectedName).map((match) => {
      return match.order;
    }),
  );
  return relevantMatches.filter((match) => {
    return selectedOrders.has(match.order);
  });
}

function connectorAmbiguityReason(
  intent: FirewallConnectorIntent,
): ConnectorRouteAmbiguityReason {
  if (intent.status === "absent") return "connector_intent_required";
  if (intent.status === "malformed") return "malformed_connector_intent";
  return "connector_intent_not_candidate";
}

type OwnerSelection =
  | {
      readonly kind: "selected";
      readonly name: string | null;
    }
  | {
      readonly kind: "ambiguous";
      readonly decision: Extract<
        FirewallRequestDecision,
        { readonly kind: "ambiguous" }
      >;
    };

function selectOwner(
  collection: FirewallMatchCollection,
  intent: FirewallConnectorIntent,
  upperMethod: string,
  path: string,
): OwnerSelection {
  const [owner, ...otherOwners] = winningOwnerNames(collection);
  if (owner === undefined) return { kind: "selected", name: null };
  if (otherOwners.length === 0 && intent.status === "absent") {
    return { kind: "selected", name: owner };
  }
  const owners = [owner, ...otherOwners];
  if (intent.status === "present") {
    const selectedName = ownerNameForIntent(collection, intent.value);
    if (selectedName !== null) {
      return { kind: "selected", name: selectedName };
    }
  }
  return {
    kind: "ambiguous",
    decision: {
      kind: "ambiguous",
      method: upperMethod,
      path,
      candidates: owners,
      reason: connectorAmbiguityReason(intent),
    },
  };
}

function conflictingSelectedApiDecision(
  collection: FirewallMatchCollection,
  selectedName: string,
): FirewallRequestDecision | null {
  const [first, ...otherMatches] = selectedOwnerApiMatches(
    collection,
    selectedName,
  ).filter((match) => {
    return (
      !match.firewall.nameMalformed &&
      !match.api.baseMalformed &&
      !match.api.authMalformed &&
      match.api.routingIdentity !== null
    );
  });
  if (first === undefined || otherMatches.length === 0) return null;
  if (
    otherMatches.every((match) => {
      return match.api.routingIdentity === first.api.routingIdentity;
    })
  ) {
    return null;
  }
  return {
    kind: "block",
    firewallName: selectedName,
    base: first.blockMatch.base,
    relativePath: first.blockMatch.relativePath,
    reason: "malformed_firewall_config",
    permissions: [],
  };
}

function reduceSelectedOwner(
  collection: FirewallMatchCollection,
  selectedName: string | null,
  networkPolicies: CompiledNetworkPolicies,
): FirewallRequestDecision {
  if (selectedName !== null) {
    const conflict = conflictingSelectedApiDecision(collection, selectedName);
    if (conflict !== null) return conflict;
  }

  const state = createDecisionState();
  const evaluableApiOrders = new Set<number>();
  const relevantApiMatches = relevantOwnerApiMatches(collection, selectedName);

  for (const apiMatch of selectedBaseApiMatches(collection, selectedName)) {
    acceptDecisionBaseMatch(state, apiMatch.baseMatch, apiMatch.score);
  }

  for (const apiMatch of relevantApiMatches) {
    const { firewall, api, blockMatch } = apiMatch;
    const policy = networkPolicies.policies.get(firewall.name);
    recordMalformedDecisionState(state, api, blockMatch);
    if (apiCannotEvaluateRules(firewall, api)) continue;
    if (policyCannotEvaluateRules(networkPolicies, policy)) {
      state.malformedPolicyMatch ??= blockMatch;
      continue;
    }
    evaluableApiOrders.add(apiMatch.order);
  }

  for (const ruleMatch of collection.ruleMatches) {
    const { apiMatch, rule } = ruleMatch;
    if (!evaluableApiOrders.has(apiMatch.order)) continue;
    const policy = networkPolicies.policies.get(apiMatch.firewall.name);
    if (!acceptRuleSpecificity(state, rule.specificity)) continue;
    if (
      policy !== undefined &&
      policy.blockedPermissions.has(rule.permission)
    ) {
      recordDeniedRule(state, apiMatch.blockMatch, rule.permission);
      continue;
    }
    state.allowedMatch ??= {
      firewallName: apiMatch.baseMatch.firewallName,
      base: apiMatch.baseMatch.allowBase,
      relativePath: apiMatch.baseMatch.relativePath,
      permission: rule.permission,
      rule: rule.raw,
    };
  }

  return resolveFirewallDecision(state, networkPolicies);
}

export function matchFirewallBaseUrl(
  url: string,
  rawBase: string,
): FirewallBaseUrlMatch | null {
  if (
    hasUnsafeRuntimeUrlSyntax(url) ||
    hasMalformedRuntimeAuthoritySyntax(url)
  ) {
    return null;
  }

  const runtimeAuthorityOrigin = runtimeAuthorityOriginForHostValidation(url);

  try {
    if (runtimeAuthorityOrigin !== null) {
      validateBaseUrl(runtimeAuthorityOrigin, "runtime");
    }
    validateBaseUrl(rawBase, "firewall");
    return matchStaticFirewallBaseUrl(url, rawBase);
  } catch {
    return null;
  }
}

export function matchFirewallRequestDecision(
  firewalls: unknown,
  method: string,
  url: string,
  networkPolicies: unknown = undefined,
  connectorIntent: FirewallConnectorIntent = { status: "absent" },
): FirewallRequestDecision {
  const decisionFirewalls = compileDecisionFirewalls(firewalls);
  if (decisionFirewalls.length === 0) return { kind: "no_match" };

  const compiledNetworkPolicies = compileNetworkPolicies(networkPolicies);
  const upperMethod = method.toUpperCase();
  const collection = createMatchCollection();
  const unsafePath =
    url.includes("\\") || hasUnsafeFirewallPath(rawPathFromUrl(url));
  let apiOrder = 0;

  for (const firewall of decisionFirewalls) {
    for (const api of firewall.apis) {
      const order = apiOrder;
      apiOrder += 1;
      const baseMatch = matchFirewallBaseUrlForDecision(url, api.rawBase);
      if (baseMatch === null) continue;
      if (unsafePath) return unsafePathBlockDecision(firewall, baseMatch);

      const decisionBaseMatch: DecisionBaseMatch = {
        firewallName: firewall.name,
        base: baseMatch.displayBase,
        allowBase: api.rawBase,
        relativePath: baseMatch.relativePath,
      };
      const apiMatch: CollectedApiMatch = {
        order,
        firewall,
        api,
        baseMatch: decisionBaseMatch,
        blockMatch: {
          firewallName: decisionBaseMatch.firewallName,
          base: decisionBaseMatch.base,
          relativePath: decisionBaseMatch.relativePath,
        },
        score: baseMatch.score,
      };
      if (!acceptCollectedApi(collection, apiMatch)) continue;
      collectDecisionRules(collection, apiMatch, upperMethod);
    }
  }

  const selection = selectOwner(
    collection,
    connectorIntent,
    upperMethod,
    rawPathFromUrl(url),
  );
  if (selection.kind === "ambiguous") return selection.decision;
  return reduceSelectedOwner(
    collection,
    selection.name,
    compiledNetworkPolicies,
  );
}

function matchFirewallHostWithParser(
  host: string,
  pattern: string,
  parsePatternSegment: SegmentMatchParser,
): Record<string, string> | null {
  const hostSegsOrig = host.split(".");
  const hostSegsLower = hostSegsOrig.map((segment) => {
    return segment.toLowerCase();
  });
  const patternSegs = pattern.split(".").reverse();

  hostSegsOrig.reverse();
  hostSegsLower.reverse();

  const params: Record<string, string> = {};
  let hi = 0;
  const lastPatternIndex = patternSegs.length - 1;

  for (
    let patternIndex = 0;
    patternIndex < patternSegs.length;
    patternIndex++
  ) {
    const seg = patternSegs[patternIndex]!;
    const parsed = parsePatternSegment(seg, patternIndex, lastPatternIndex);
    if (parsed === null) return null;
    if (parsed.kind === "literal") {
      if (
        hi >= hostSegsLower.length ||
        hostSegsLower[hi] !== parsed.value.toLowerCase()
      ) {
        return null;
      }
      hi += 1;
      continue;
    }

    const { name, prefix, suffix, greedy } = parsed;
    if (greedy === "+") {
      if (hi >= hostSegsOrig.length) return null;
      params[name] = hostSegsOrig.slice(hi).reverse().join(".");
      return params;
    }
    if (greedy === "*") {
      params[name] = hostSegsOrig.slice(hi).reverse().join(".");
      return params;
    }
    if (hi >= hostSegsOrig.length) return null;
    if (prefix === "" && suffix === "") {
      params[name] = hostSegsLower[hi]!;
    } else {
      const captured = matchMixedSegment(
        hostSegsLower[hi]!,
        prefix.toLowerCase(),
        suffix.toLowerCase(),
      );
      if (captured === null) return null;
      params[name] = captured;
    }
    hi += 1;
  }

  return hi === hostSegsOrig.length ? params : null;
}

/**
 * Match a runtime host/authority against a firewall base host pattern.
 *
 * Host comparison is case-insensitive and mirrors the runner's right-to-left
 * host matcher. Non-default ports are part of the normalized authority and
 * therefore participate in the final host segment comparison.
 */
export function matchFirewallHost(
  host: string,
  pattern: string,
): Record<string, string> | null {
  return matchFirewallHostWithParser(host, pattern, parseStrictMatchSegment);
}

function parseMalformedTolerantBaseSegment(
  segment: string,
  patternIndex: number,
  lastPatternIndex: number,
): MatchableSegment {
  const parsed = parseSegment(segment);
  if (parsed.kind === "error") {
    return {
      kind: "param",
      prefix: "",
      name: `__malformed_base_segment_${patternIndex}`,
      suffix: "",
      greedy: "",
    };
  }
  if (
    parsed.kind === "param" &&
    parsed.greedy !== "" &&
    isInvalidGreedyParam(
      patternIndex,
      lastPatternIndex,
      parsed.prefix,
      parsed.suffix,
    )
  ) {
    return { ...parsed, greedy: "" };
  }
  return parsed;
}

function matchFirewallHostForMalformedBaseDecision(
  host: string,
  pattern: string,
): Record<string, string> | null {
  return matchFirewallHostWithParser(
    host,
    pattern,
    parseMalformedTolerantBaseSegment,
  );
}

function matchFirewallPathPrefixWithParser(
  path: string,
  pattern: string,
  parsePatternSegment: SegmentMatchParser,
): string | null {
  const pathSegs = splitPathSegments(path);
  const patternSegs = splitPathSegments(pattern);

  let pi = 0;
  const lastPatternIndex = patternSegs.length - 1;
  for (
    let patternIndex = 0;
    patternIndex < patternSegs.length;
    patternIndex++
  ) {
    const seg = patternSegs[patternIndex]!;
    const parsed = parsePatternSegment(seg, patternIndex, lastPatternIndex);
    if (parsed === null) return null;
    if (parsed.kind === "literal") {
      if (pi >= pathSegs.length || pathSegs[pi] !== parsed.value) return null;
      pi += 1;
      continue;
    }

    const { prefix, suffix, greedy } = parsed;
    if (greedy === "+") {
      if (pi >= pathSegs.length || !hasNonEmptySegment(pathSegs, pi)) {
        return null;
      }
      return "/";
    }
    if (greedy === "*") {
      return "/";
    }
    if (pi >= pathSegs.length) return null;

    const runtime = pathSegs[pi]!;
    if (prefix === "" && suffix === "") {
      if (runtime === "") return null;
    } else if (matchMixedSegment(runtime, prefix, suffix) === null) {
      return null;
    }
    pi += 1;
  }

  return relativePathFromSegments(pathSegs, pi);
}

/**
 * Match a runtime path against the beginning of a firewall base path pattern.
 *
 * Unlike matchFirewallPath(), this intentionally allows extra runtime path
 * segments and returns the remaining relative path after the base prefix.
 */
export function matchFirewallPathPrefix(
  path: string,
  pattern: string,
): string | null {
  return matchFirewallPathPrefixWithParser(
    path,
    pattern,
    parseStrictMatchSegment,
  );
}

function matchFirewallPathPrefixForMalformedBaseDecision(
  path: string,
  pattern: string,
): string | null {
  return matchFirewallPathPrefixWithParser(
    path,
    pattern,
    parseMalformedTolerantBaseSegment,
  );
}

/**
 * Match a URL path against a rule path pattern.
 *
 * Ported from the Python MITM addon's `match_path()` function
 * (crates/runner/mitm-addon/src/matching.py).
 *
 * - Literal segments must match exactly (case-sensitive).
 * - `{name}` matches a single non-empty path segment.
 * - `prefix{name}suffix` (mixed) matches a segment that starts with
 *   `prefix` and ends with `suffix`, with a non-empty middle captured
 *   into `name`.
 * - `{name+}` matches the rest of the path (one or more segments). Must be last.
 * - `{name*}` matches the rest of the path (zero or more segments). Must be last.
 *
 * Returns extracted parameters on match, or null on mismatch.
 */
export function matchFirewallPath(
  path: string,
  pattern: string,
): Record<string, string> | null {
  const pathSegs = splitPathSegments(path);
  const patternSegs = splitPathSegments(pattern);

  const params: Record<string, string> = {};
  let pi = 0;
  const lastPatternIndex = patternSegs.length - 1;

  for (
    let patternIndex = 0;
    patternIndex < patternSegs.length;
    patternIndex++
  ) {
    const seg = patternSegs[patternIndex]!;
    const parsed = parseSegment(seg);
    // Invalid patterns are rejected by validateRule at ingest time, so
    // kind "error" should never appear here on validated inputs.
    if (parsed.kind === "error") return null;
    if (parsed.kind === "literal") {
      if (pi >= pathSegs.length || pathSegs[pi] !== parsed.value) return null;
      pi++;
      continue;
    }
    const { name, prefix, suffix, greedy } = parsed;
    if (greedy === "+") {
      if (isInvalidGreedyParam(patternIndex, lastPatternIndex, prefix, suffix))
        return null;
      if (pi >= pathSegs.length || !hasNonEmptySegment(pathSegs, pi)) {
        return null;
      }
      params[name] = pathSegs.slice(pi).join("/");
      return params;
    }
    if (greedy === "*") {
      if (isInvalidGreedyParam(patternIndex, lastPatternIndex, prefix, suffix))
        return null;
      params[name] = pathSegs.slice(pi).join("/");
      return params;
    }
    if (pi >= pathSegs.length) return null;
    const runtime = pathSegs[pi]!;
    if (prefix === "" && suffix === "") {
      if (runtime === "") return null;
      params[name] = runtime;
    } else {
      const captured = matchMixedSegment(runtime, prefix, suffix);
      if (captured === null) return null;
      params[name] = captured;
    }
    pi++;
  }

  // All pattern segments consumed; path must also be fully consumed
  if (pi !== pathSegs.length) return null;
  return params;
}

/**
 * Find permission names from a firewall config whose most-specific rules match
 * the given HTTP method and relative path.
 *
 * Method matching is case-insensitive. The special method `ANY` matches
 * any HTTP method. Path specificity mirrors the runner firewall matcher within
 * each API entry.
 */
export function findMatchingPermissions(
  method: string,
  path: string,
  config: unknown,
  options: FindMatchingPermissionsOptions = {},
): string[] {
  if (!isObjectRecord(config)) return [];
  if (typeof config.name !== "string" || config.name === "") return [];
  if (!Array.isArray(config.apis)) return [];

  const apiBase =
    options.apiBase === undefined ? null : stripTrailingSlash(options.apiBase);
  const matchApis: PermissionMatchApi[] = [];

  for (const api of config.apis) {
    const permissionRuleSets = getApiPermissionRuleSetsForMatch(
      api,
      config.name,
      apiBase,
    );
    if (permissionRuleSets !== null) {
      matchApis.push({ permissionRuleSets });
    }
  }

  return findMatchingPermissionRuleSets(method, path, matchApis);
}

function findMatchingPermissionRuleSets(
  method: string,
  path: string,
  apis: readonly PermissionMatchApi[],
): string[] {
  const upperMethod = method.toUpperCase();
  const matched: string[] = [];

  for (const api of apis) {
    const state: ApiMatchState = { bestSpecificity: null, matched: [] };

    for (const permission of api.permissionRuleSets) {
      for (const rule of permission.rules) {
        const rest = matchingRulePath(rule, upperMethod);
        if (rest === null) continue;

        if (matchFirewallPath(path, rest) !== null) {
          const specificity = pathSpecificity(rest);
          if (specificity === null) continue;
          recordPermissionMatch(state, permission.name, specificity);
        }
      }
    }

    for (const permission of state.matched) {
      if (!matched.includes(permission)) {
        matched.push(permission);
      }
    }
  }

  return matched;
}
