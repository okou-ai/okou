import {
  canonicalizeFirewallDnsHostname,
  FIREWALL_HOSTNAME_POLICY_VERSION,
} from "./firewall-hostname-policy";
import {
  firewallBaseHostPolicySchema,
  type FirewallApi,
  type FirewallBaseHostPolicy,
  type FirewallConfig,
  type FirewallPolicyValue,
  type Firewalls,
} from "./firewall-contracts";
import { hasRawWhitespace, hasUnsafeUrlCodepoint } from "./firewall-url-utils";
import { PUBLIC_DESTINATION_ADDRESS_POLICY } from "./public-destination-policy";
import { parseSegment, splitPathSegments } from "./segment-parser";

export { normalizeFirewallFixedHost } from "./firewall-url-utils";

export {
  executionFirewallBuiltinEntrySchema,
  executionFirewallEntrySchema,
  executionFirewallInlineEntrySchema,
  executionFirewallsSchema,
  firewallApiSchema,
  firewallAwsSigv4AuthSchema,
  firewallBaseHostPolicySchema,
  firewallConfigSchema,
  firewallPermissionSchema,
  firewallPoliciesSchema,
  firewallPolicySchema,
  firewallPolicyValueSchema,
  firewallSchema,
  firewallsSchema,
  networkPoliciesSchema,
  networkPolicySchema,
  UNKNOWN_PERMISSION_GRANT,
  type ExecutionFirewallBuiltinEntry,
  type ExecutionFirewallEntry,
  type ExecutionFirewallInlineEntry,
  type ExecutionFirewalls,
  type Firewall,
  type FirewallApi,
  type FirewallBaseHostPolicy,
  type FirewallConfig,
  type FirewallPolicies,
  type FirewallPolicy,
  type FirewallPolicyValue,
  type Firewalls,
  type NetworkPolicies,
  type NetworkPolicy,
  type PermissionNamesOf,
} from "./firewall-contracts";

const HOST_DOT_EQUIVALENT_PATTERN = /[\u3002\uff0e\uff61]/g;
const DNS_HOST_FORBIDDEN_ASCII_CHARS = new Set(["<", ">", "[", "]", "^", "|"]);

export class FirewallBaseUrlResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirewallBaseUrlResolutionError";
  }
}

/**
 * Regex pattern matching `${{ secrets.XXX }}` references in auth header templates.
 * Tolerates optional whitespace inside braces: `${{ secrets.X }}` and `${{secrets.X}}`.
 */
const AUTH_SECRET_PATTERN =
  /\$\{\{\s*secrets\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const AUTH_REFERENCE_PATTERN =
  /\$\{\{\s*(secrets|vars)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const AUTH_REFERENCE_PATTERN_G = new RegExp(AUTH_REFERENCE_PATTERN.source, "g");
const AUTH_REFERENCE_PREFIX_PATTERN = new RegExp(
  `^${AUTH_REFERENCE_PATTERN.source}`,
);
const AUTH_TEMPLATE_START = "${{";
const AUTH_TEMPLATE_URL_PLACEHOLDER = "placeholder";
const IPV4_MAX_OCTET = 255;
const IPV4_OCTET_BASE = IPV4_MAX_OCTET + 1;
const IPV4_NON_PUBLIC_RANGES =
  PUBLIC_DESTINATION_ADDRESS_POLICY.ipv4NonPublicRanges;
const {
  globalUnicastFirstMin: IPV6_GLOBAL_UNICAST_FIRST_MIN,
  globalUnicastFirstMax: IPV6_GLOBAL_UNICAST_FIRST_MAX,
  ietfProtocolAssignmentsFirst: IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST,
  ietfProtocolAssignmentsSecondMax: IPV6_IETF_PROTOCOL_ASSIGNMENTS_SECOND_MAX,
  documentationSecond: IPV6_DOCUMENTATION_SECOND,
  sixToFourFirst: IPV6_6TO4_FIRST,
  specialExactSecond: IPV6_SPECIAL_EXACT_SECOND,
  specialExactLastMin: IPV6_SPECIAL_EXACT_LAST_MIN,
  specialExactLastMax: IPV6_SPECIAL_EXACT_LAST_MAX,
  amtSecond: IPV6_AMT_SECOND,
  as112Second: IPV6_AS112_SECOND,
  as112Third: IPV6_AS112_THIRD,
  orchidSecondMin: IPV6_ORCHID_SECOND_MIN,
  orchidSecondMax: IPV6_ORCHID_SECOND_MAX,
  droneRemoteIdSecondMin: IPV6_DRONE_REMOTE_ID_SECOND_MIN,
  droneRemoteIdSecondMax: IPV6_DRONE_REMOTE_ID_SECOND_MAX,
  expandedDocumentationFirst: IPV6_EXPANDED_DOCUMENTATION_FIRST,
  expandedDocumentationSecondMax: IPV6_EXPANDED_DOCUMENTATION_SECOND_MAX,
} = PUBLIC_DESTINATION_ADDRESS_POLICY.ipv6;

export type FirewallTemplateReferenceNamespace = "secrets" | "vars";

export interface FirewallTemplateReferences {
  readonly secrets: readonly string[];
  readonly vars: readonly string[];
}

export interface BasicAuthTemplateArg {
  readonly namespace?: FirewallTemplateReferenceNamespace;
  readonly key?: string;
  readonly literal?: string;
}

export interface BasicAuthTemplateMatch {
  readonly start: number;
  readonly end: number;
  readonly first: BasicAuthTemplateArg;
  readonly second: BasicAuthTemplateArg;
}

interface ParsedBasicArg {
  readonly arg: BasicAuthTemplateArg | null;
  readonly index: number;
}

interface ParsedBasicTemplate {
  readonly match: BasicAuthTemplateMatch | null;
  readonly index: number;
}

interface BasicAuthTemplateParserContext {
  readonly nextQuoteIndexes: Int32Array;
  readonly nextBackslashIndexes: Int32Array;
  readonly nextTemplateIndexes: Int32Array;
}

function isTemplateWhitespace(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "\f" ||
    char === "\v"
  );
}

function skipTemplateWhitespace(template: string, index: number): number {
  let nextIndex = index;
  while (
    nextIndex < template.length &&
    isTemplateWhitespace(template[nextIndex]!)
  ) {
    nextIndex += 1;
  }
  return nextIndex;
}

function isIdentifierStart(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    char === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
  );
}

function isIdentifierPart(char: string): boolean {
  const code = char.charCodeAt(0);
  return isIdentifierStart(char) || (code >= 48 && code <= 57);
}

function parseTemplateIdentifier(
  template: string,
  index: number,
): { readonly value: string; readonly index: number } | null {
  if (index >= template.length || !isIdentifierStart(template[index]!)) {
    return null;
  }

  let nextIndex = index + 1;
  while (
    nextIndex < template.length &&
    isIdentifierPart(template[nextIndex]!)
  ) {
    nextIndex += 1;
  }
  return {
    value: template.slice(index, nextIndex),
    index: nextIndex,
  };
}

function createBasicAuthTemplateParserContext(
  template: string,
): BasicAuthTemplateParserContext {
  const nextQuoteIndexes = new Int32Array(template.length + 1);
  const nextBackslashIndexes = new Int32Array(template.length + 1);
  const nextTemplateIndexes = new Int32Array(template.length + 1);
  let nextQuoteIndex = -1;
  let nextBackslashIndex = -1;
  let nextTemplateIndex = -1;
  nextQuoteIndexes[template.length] = nextQuoteIndex;
  nextBackslashIndexes[template.length] = nextBackslashIndex;
  nextTemplateIndexes[template.length] = nextTemplateIndex;

  for (let index = template.length - 1; index >= 0; index -= 1) {
    if (template[index] === '"') {
      nextQuoteIndex = index;
    }
    if (template[index] === "\\") {
      nextBackslashIndex = index;
    }
    if (template.startsWith("${{", index)) {
      nextTemplateIndex = index;
    }
    nextQuoteIndexes[index] = nextQuoteIndex;
    nextBackslashIndexes[index] = nextBackslashIndex;
    nextTemplateIndexes[index] = nextTemplateIndex;
  }

  return { nextQuoteIndexes, nextBackslashIndexes, nextTemplateIndexes };
}

function parseBasicAuthTemplateArg(
  context: BasicAuthTemplateParserContext,
  template: string,
  index: number,
): ParsedBasicArg {
  let nextIndex = skipTemplateWhitespace(template, index);
  const char = template[nextIndex];
  if (char === "," || char === ")") {
    return { arg: {}, index: nextIndex };
  }

  if (char === '"') {
    const literalStart = nextIndex + 1;
    const quoteIndex = context.nextQuoteIndexes[literalStart] ?? -1;
    if (quoteIndex === -1) {
      const nestedTemplateStart =
        context.nextTemplateIndexes[literalStart] ?? -1;
      return {
        arg: null,
        index:
          nestedTemplateStart === -1 ? template.length : nestedTemplateStart,
      };
    }
    const escapeIndex = context.nextBackslashIndexes[literalStart] ?? -1;
    if (escapeIndex !== -1 && escapeIndex < quoteIndex) {
      const nestedTemplateStart =
        context.nextTemplateIndexes[literalStart] ?? -1;
      return {
        arg: null,
        index:
          nestedTemplateStart !== -1 && nestedTemplateStart < escapeIndex
            ? nestedTemplateStart
            : escapeIndex + 1,
      };
    }
    return {
      arg: { literal: template.slice(literalStart, quoteIndex) },
      index: quoteIndex + 1,
    };
  }

  let namespace: FirewallTemplateReferenceNamespace;
  if (template.startsWith("secrets.", nextIndex)) {
    namespace = "secrets";
    nextIndex += "secrets.".length;
  } else if (template.startsWith("vars.", nextIndex)) {
    namespace = "vars";
    nextIndex += "vars.".length;
  } else {
    return { arg: null, index: nextIndex };
  }

  const key = parseTemplateIdentifier(template, nextIndex);
  if (!key) {
    return { arg: null, index: nextIndex };
  }
  return {
    arg: { namespace, key: key.value },
    index: key.index,
  };
}

function parseBasicAuthTemplateAt(
  context: BasicAuthTemplateParserContext,
  template: string,
  start: number,
): ParsedBasicTemplate {
  let index = start + "${{".length;
  index = skipTemplateWhitespace(template, index);
  if (!template.startsWith("basic(", index)) {
    return { match: null, index: start + "${{".length };
  }
  index += "basic(".length;

  const first = parseBasicAuthTemplateArg(context, template, index);
  if (!first.arg) {
    return { match: null, index: first.index };
  }
  index = skipTemplateWhitespace(template, first.index);
  if (template[index] !== ",") {
    return { match: null, index: Math.max(index + 1, first.index) };
  }
  index += 1;

  const second = parseBasicAuthTemplateArg(context, template, index);
  if (!second.arg) {
    return { match: null, index: second.index };
  }
  index = skipTemplateWhitespace(template, second.index);
  if (template[index] !== ")") {
    return { match: null, index: Math.max(index + 1, second.index) };
  }
  index += 1;
  index = skipTemplateWhitespace(template, index);
  if (!template.startsWith("}}", index)) {
    return { match: null, index: Math.max(index + 1, second.index) };
  }

  const end = index + "}}".length;
  return {
    match: {
      start,
      end,
      first: first.arg,
      second: second.arg,
    },
    index: end,
  };
}

function findNextBasicAuthTemplateStart(
  template: string,
  index: number,
): number {
  let basicIndex = template.indexOf("basic(", index);
  while (basicIndex !== -1) {
    let contentStart = basicIndex;
    while (
      contentStart > index &&
      isTemplateWhitespace(template[contentStart - 1]!)
    ) {
      contentStart -= 1;
    }

    const start = contentStart - "${{".length;
    if (start >= index && template.startsWith("${{", start)) {
      return start;
    }

    basicIndex = template.indexOf("basic(", basicIndex + "basic(".length);
  }
  return -1;
}

/**
 * Parse `${{ basic(username, password) }}` templates in linear time.
 * Each side is secrets.X, vars.X, "literal", or empty; comma is required.
 * Literal strings forbid `"` and `\`, and are not subject to simple template
 * resolution.
 */
export function parseBasicAuthTemplates(
  template: string,
): readonly BasicAuthTemplateMatch[] {
  const matches: BasicAuthTemplateMatch[] = [];
  let start = findNextBasicAuthTemplateStart(template, 0);
  if (start === -1) {
    return matches;
  }

  const context = createBasicAuthTemplateParserContext(template);

  while (start !== -1) {
    const parsed = parseBasicAuthTemplateAt(context, template, start);
    if (parsed.match) {
      matches.push(parsed.match);
      start = findNextBasicAuthTemplateStart(template, parsed.index);
    } else {
      start = findNextBasicAuthTemplateStart(
        template,
        Math.max(parsed.index, start + "${{".length),
      );
    }
  }

  return matches;
}

export function replaceBasicAuthTemplates(
  template: string,
  replacer: (match: BasicAuthTemplateMatch) => string,
): string {
  const matches = parseBasicAuthTemplates(template);
  if (matches.length === 0) {
    return template;
  }

  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of matches) {
    parts.push(template.slice(lastIndex, match.start), replacer(match));
    lastIndex = match.end;
  }
  parts.push(template.slice(lastIndex));
  return parts.join("");
}

function forEachSimpleAuthReference(
  template: string,
  basicMatches: readonly BasicAuthTemplateMatch[],
  callback: (namespace: string, name: string) => void,
): void {
  let basicMatchIndex = 0;

  for (const match of template.matchAll(AUTH_REFERENCE_PATTERN)) {
    if (!match[1] || !match[2] || match.index === undefined) {
      continue;
    }

    while (
      basicMatchIndex < basicMatches.length &&
      basicMatches[basicMatchIndex]!.end <= match.index
    ) {
      basicMatchIndex += 1;
    }

    const basicMatch = basicMatches[basicMatchIndex];
    if (
      basicMatch &&
      match.index >= basicMatch.start &&
      match.index < basicMatch.end
    ) {
      continue;
    }

    callback(match[1], match[2]);
  }
}

/**
 * Extract all secret names referenced in firewall rule auth header templates.
 * Handles both simple `${{ secrets.X }}` and `${{ basic(...) }}` templates.
 * E.g., `Bearer ${{ secrets.GITHUB_TOKEN }}` → `["GITHUB_TOKEN"]`
 */
export function extractSecretNamesFromApis(
  apis: FirewallConfig["apis"],
): string[] {
  const names = new Set<string>();
  for (const entry of apis) {
    for (const value of Object.values(entry.auth.headers ?? {})) {
      const basicMatches = parseBasicAuthTemplates(value);
      forEachSimpleAuthReference(value, basicMatches, (namespace, name) => {
        if (namespace === "secrets") {
          names.add(name);
        }
      });
      // basic() args may reference secrets, vars, or be string literals;
      // only collect secrets here (vars don't need placeholders, literals
      // are baked into the config).
      for (const match of basicMatches) {
        if (match.first.namespace === "secrets" && match.first.key) {
          names.add(match.first.key);
        }
        if (match.second.namespace === "secrets" && match.second.key) {
          names.add(match.second.key);
        }
      }
    }
    // Scan auth.base for secret references (webhook-url connectors).
    // Only simple ${{ secrets.X }} — basic() makes no sense in a URL template.
    if (entry.auth.base) {
      for (const match of entry.auth.base.matchAll(AUTH_SECRET_PATTERN)) {
        names.add(match[1]!);
      }
    }
    // Scan auth.query for secret references (query-param auth connectors).
    // Only simple ${{ secrets.X }} — basic() makes no sense in query params.
    if (entry.auth.query) {
      for (const value of Object.values(entry.auth.query)) {
        for (const match of value.matchAll(AUTH_SECRET_PATTERN)) {
          names.add(match[1]!);
        }
      }
    }
    if (entry.auth.awsSigv4) {
      for (const value of Object.values(entry.auth.awsSigv4)) {
        if (!value) continue;
        for (const match of value.matchAll(AUTH_SECRET_PATTERN)) {
          names.add(match[1]!);
        }
      }
    }
  }
  return [...names];
}

function collectFirewallTemplateReferencesFromValue(
  template: string,
  references: { secrets: Set<string>; vars: Set<string> },
): void {
  const basicMatches = parseBasicAuthTemplates(template);
  const addReference = (namespace: string, name: string): void => {
    if (namespace === "secrets") {
      references.secrets.add(name);
    } else if (namespace === "vars") {
      references.vars.add(name);
    }
  };

  forEachSimpleAuthReference(template, basicMatches, addReference);
  for (const match of basicMatches) {
    if (match.first.namespace && match.first.key) {
      addReference(match.first.namespace, match.first.key);
    }
    if (match.second.namespace && match.second.key) {
      addReference(match.second.namespace, match.second.key);
    }
  }
}

export function extractFirewallTemplateReferences(
  apis: FirewallConfig["apis"],
): FirewallTemplateReferences {
  const references = {
    secrets: new Set<string>(),
    vars: new Set<string>(),
  };

  for (const entry of apis) {
    for (const value of Object.values(entry.auth.headers ?? {})) {
      collectFirewallTemplateReferencesFromValue(value, references);
    }
    if (entry.auth.base) {
      collectFirewallTemplateReferencesFromValue(entry.auth.base, references);
    }
    for (const value of Object.values(entry.auth.query ?? {})) {
      collectFirewallTemplateReferencesFromValue(value, references);
    }
    for (const value of Object.values(entry.auth.awsSigv4 ?? {})) {
      if (value) {
        collectFirewallTemplateReferencesFromValue(value, references);
      }
    }
  }

  return {
    secrets: [...references.secrets],
    vars: [...references.vars],
  };
}

/**
 * Regex pattern matching `${{ vars.XXX }}` references in base URL templates.
 */
const BASE_URL_VARS_PATTERN = /\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/;
const BASE_URL_VARS_PATTERN_G = new RegExp(BASE_URL_VARS_PATTERN.source, "g");
const URL_COMPONENT_DELIMITER_PATTERN = /[/?#]/;
const AUTHORITY_VAR_STRUCTURE_CHARS = new Set(["/", "?", "#", "@", "\\"]);
const AUTHORITY_FRAGMENT_VAR_STRUCTURE_CHARS = new Set([
  "/",
  ":",
  "?",
  "#",
  "@",
  "\\",
]);
const PERCENT_DECODED_BOUNDARY_CHARS = new Set(["/", ":", "?", "#", "@", "\\"]);
const BASE_URL_VAR_PARAMETER_CHARS = new Set(["{", "}"]);
const PATH_VAR_STRUCTURE_CHARS = new Set(["/", "?", "#", "\\"]);
const PORT_VAR_PATTERN = /^[0-9]+$/;
const MAX_PATH_PERCENT_DECODE_PASSES = 5;

/**
 * Check if a base URL contains `${{ vars.X }}` template references.
 */
export function hasBaseUrlVars(base: string): boolean {
  return BASE_URL_VARS_PATTERN.test(base);
}

export function extractBaseUrlVarNames(base: string): string[] {
  const names = new Set<string>();
  for (const match of base.matchAll(BASE_URL_VARS_PATTERN_G)) {
    names.add(match[1]!);
  }
  return [...names];
}

function baseUrlVariableError(
  base: string,
  serviceName: string,
  name: string,
  detail: string,
): Error {
  return new Error(
    errMsg(base, serviceName, `base URL variable "${name}" ${detail}`),
  );
}

function validateBaseUrlVariableCommonSyntax({
  base,
  serviceName,
  name,
  value,
}: {
  readonly base: string;
  readonly serviceName: string;
  readonly name: string;
  readonly value: string;
}): void {
  if (WHITESPACE_PATTERN.test(value)) {
    throw baseUrlVariableError(
      base,
      serviceName,
      name,
      "must not contain whitespace",
    );
  }
  if (hasUnsafeUrlCodepoint(value)) {
    throw baseUrlVariableError(
      base,
      serviceName,
      name,
      "must not contain control characters or invalid Unicode",
    );
  }
  for (const char of value) {
    if (BASE_URL_VAR_PARAMETER_CHARS.has(char)) {
      throw baseUrlVariableError(
        base,
        serviceName,
        name,
        "must not contain firewall parameter syntax",
      );
    }
  }
}

function pathPartDotPrefix(part: string): string {
  return part.split(";", 1)[0]!;
}

function pathPartIsDotSegment(part: string): boolean {
  const dotPrefix = pathPartDotPrefix(part);
  return dotPrefix === "." || dotPrefix === "..";
}

function pathSegmentContainsDotPathPart(segment: string): boolean {
  if (pathPartIsDotSegment(segment)) return true;
  return segment.split("/").some((part) => {
    return pathPartIsDotSegment(part);
  });
}

function pathSegmentHasUnsafeSyntaxParts(
  segment: string,
  rejectPathStructure: boolean,
): boolean {
  if (hasUnsafeUrlCodepoint(segment)) return true;
  if (segment.includes("\\")) return true;
  if (pathSegmentContainsDotPathPart(segment)) return true;
  if (!rejectPathStructure) return false;
  for (const char of segment) {
    if (PATH_VAR_STRUCTURE_CHARS.has(char)) return true;
  }
  return false;
}

function normalizedPathSegmentHasUnsafeSyntax(
  segment: string,
  rejectPathStructure: boolean,
): boolean {
  const normalized = segment.normalize("NFKC");
  if (normalized === segment) return false;
  if (normalized.includes("%")) return true;
  return pathSegmentHasUnsafeSyntaxParts(normalized, rejectPathStructure);
}

function percentDecodePathSegment(
  segment: string,
  rejectPathStructure: boolean,
): string | null {
  if (!segment.includes("%")) return segment;
  for (let i = 0; i < segment.length; i += 1) {
    if (segment[i] !== "%") continue;
    if (
      i + 2 >= segment.length ||
      !isHexDigit(segment[i + 1]!) ||
      !isHexDigit(segment[i + 2]!)
    ) {
      return null;
    }
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (rejectPathStructure) {
    for (const char of decoded) {
      if (
        PATH_VAR_STRUCTURE_CHARS.has(char) ||
        WHITESPACE_PATTERN.test(char) ||
        UNICODE_CONTROL_PATTERN.test(char)
      ) {
        return null;
      }
    }
  }
  return decoded;
}

function pathSegmentHasUnsafeSyntax(
  segment: string,
  rejectPathStructure: boolean,
): boolean {
  let current = segment;
  for (let pass = 0; pass < MAX_PATH_PERCENT_DECODE_PASSES; pass += 1) {
    if (
      pathSegmentHasUnsafeSyntaxParts(current, rejectPathStructure) ||
      normalizedPathSegmentHasUnsafeSyntax(current, rejectPathStructure)
    ) {
      return true;
    }
    const decoded = percentDecodePathSegment(current, rejectPathStructure);
    if (decoded === null) return true;
    if (decoded === current) return false;
    current = decoded;
  }

  if (
    pathSegmentHasUnsafeSyntaxParts(current, rejectPathStructure) ||
    normalizedPathSegmentHasUnsafeSyntax(current, rejectPathStructure)
  ) {
    return true;
  }
  const decoded = percentDecodePathSegment(current, rejectPathStructure);
  return decoded === null || decoded !== current;
}

export function hasUnsafeFirewallPath(path: string): boolean {
  return path.split("/").some((segment) => {
    return pathSegmentHasUnsafeSyntax(segment, false);
  });
}

/** RFC URI normalization; reserved escapes remain path data, never structure. */
export function canonicalFirewallPathPercentEncoding(path: string): string {
  return path.replace(/%[\da-f]{2}/gi, (escape) => {
    const char = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return /^[A-Za-z0-9._~-]$/.test(char) ? char : escape.toUpperCase();
  });
}

/** Bounded owner-discovery paths; unsafe candidates must never authorize a request. */
export function firewallRequestPathInterpretations(path: string): {
  readonly paths: readonly string[];
  readonly unsafe: boolean;
  readonly budgetExceeded: boolean;
} {
  const paths = [path];
  let current = path;
  let unsafe = false;
  for (let pass = 0; pass < MAX_PATH_PERCENT_DECODE_PASSES; pass += 1) {
    const canonical = canonicalFirewallPathPercentEncoding(current);
    if (canonical !== current && !paths.includes(canonical))
      paths.push(canonical);
    if (!current.includes("%")) return { paths, unsafe, budgetExceeded: false };
    const decodedSegments: string[] = [];
    for (const segment of current.split("/")) {
      try {
        decodedSegments.push(decodeURIComponent(segment));
      } catch {
        unsafe = true;
        decodedSegments.push(segment);
      }
    }
    const decoded = decodedSegments.join("/");
    // Keep these opaque paths only to discover an owner before rejecting.
    unsafe ||= decoded.includes("?") || decoded.includes("#");
    if (decoded === current) return { paths, unsafe, budgetExceeded: false };
    paths.push(decoded);
    current = decoded;
  }
  const budgetExceeded = current.includes("%");
  return { paths, unsafe: unsafe || budgetExceeded, budgetExceeded };
}

function validateBaseUrlVariablePercentEncoding({
  base,
  serviceName,
  name,
  value,
  structureChars,
}: {
  readonly base: string;
  readonly serviceName: string;
  readonly name: string;
  readonly value: string;
  readonly structureChars: ReadonlySet<string>;
}): string {
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "%") {
      continue;
    }
    if (
      i + 2 >= value.length ||
      !isHexDigit(value[i + 1]!) ||
      !isHexDigit(value[i + 2]!)
    ) {
      throw baseUrlVariableError(
        base,
        serviceName,
        name,
        "has invalid percent encoding",
      );
    }

    let end = i;
    while (
      end + 2 < value.length &&
      value[end] === "%" &&
      isHexDigit(value[end + 1]!) &&
      isHexDigit(value[end + 2]!)
    ) {
      end += 3;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(value.slice(i, end));
    } catch {
      throw baseUrlVariableError(
        base,
        serviceName,
        name,
        "has invalid percent encoding",
      );
    }
    for (const char of decoded) {
      if (
        structureChars.has(char) ||
        WHITESPACE_PATTERN.test(char) ||
        UNICODE_CONTROL_PATTERN.test(char)
      ) {
        throw baseUrlVariableError(
          base,
          serviceName,
          name,
          "must not contain encoded URL structure",
        );
      }
    }
    i = end - 1;
  }
  if (!value.includes("%")) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw baseUrlVariableError(
      base,
      serviceName,
      name,
      "has invalid percent encoding",
    );
  }
}

function validateBaseUrlPathSegment({
  base,
  serviceName,
  name,
  segment,
}: {
  readonly base: string;
  readonly serviceName: string;
  readonly name: string;
  readonly segment: string;
}): void {
  if (pathSegmentHasUnsafeSyntax(segment, true)) {
    throw baseUrlVariableError(
      base,
      serviceName,
      name,
      "must not contain unsafe path segments",
    );
  }
}

function rawPathFromBaseUrl(value: string): string {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd === -1) return "";
  const afterScheme = value.slice(schemeEnd + 3);
  const pathStart = afterScheme.search(/[/?#]/);
  if (pathStart === -1 || afterScheme[pathStart] !== "/") return "";
  const pathAndAfter = afterScheme.slice(pathStart);
  const pathEnd = pathAndAfter.search(/[?#]/);
  return pathEnd === -1 ? pathAndAfter : pathAndAfter.slice(0, pathEnd);
}

function validateBaseUrlPrefixVariable({
  base,
  serviceName,
  name,
  value,
}: {
  readonly base: string;
  readonly serviceName: string;
  readonly name: string;
  readonly value: string;
}): void {
  const rawPath = rawPathFromBaseUrl(value);
  if (hasUnsafeFirewallPath(rawPath)) {
    throw baseUrlVariableError(
      base,
      serviceName,
      name,
      "must not contain unsafe path segments before a fixed path suffix",
    );
  }
  const canonicalValue = canonicalizeFirewallBaseUrl(value, serviceName);
  const url = urlForCanonicalBaseSyntax(canonicalValue);
  if (url.search || url.hash) {
    throw baseUrlVariableError(
      base,
      serviceName,
      name,
      "must not contain query or fragment before a fixed path suffix",
    );
  }
}

function validateResolvedBaseUrlPathSafety(
  templateBase: string,
  serviceName: string,
  resolved: string,
): void {
  const rawPath = rawPathFromBaseUrl(resolved);
  for (const segment of rawPath.split("/")) {
    if (pathSegmentHasUnsafeSyntax(segment, false)) {
      throw new Error(
        errMsg(
          templateBase,
          serviceName,
          "resolved base URL must not contain unsafe path segments",
        ),
      );
    }
  }
}

function validateBaseUrlAuthorityVariable({
  base,
  serviceName,
  name,
  value,
}: {
  readonly base: string;
  readonly serviceName: string;
  readonly name: string;
  readonly value: string;
}): void {
  for (const char of value) {
    if (AUTHORITY_VAR_STRUCTURE_CHARS.has(char)) {
      throw baseUrlVariableError(
        base,
        serviceName,
        name,
        "must not introduce URL structure",
      );
    }
  }
  validateBaseUrlVariablePercentEncoding({
    base,
    serviceName,
    name,
    value,
    structureChars: PERCENT_DECODED_BOUNDARY_CHARS,
  });
  validateBaseUrl(`https://${value}`, serviceName);
}

function validateBaseUrlAuthorityFragmentVariable({
  base,
  serviceName,
  name,
  value,
}: {
  readonly base: string;
  readonly serviceName: string;
  readonly name: string;
  readonly value: string;
}): void {
  for (const char of value) {
    if (AUTHORITY_FRAGMENT_VAR_STRUCTURE_CHARS.has(char)) {
      throw baseUrlVariableError(
        base,
        serviceName,
        name,
        "must not introduce URL structure",
      );
    }
  }
  validateBaseUrlVariablePercentEncoding({
    base,
    serviceName,
    name,
    value,
    structureChars: PERCENT_DECODED_BOUNDARY_CHARS,
  });
}

function validateBaseUrlPortVariable({
  base,
  serviceName,
  name,
  value,
}: {
  readonly base: string;
  readonly serviceName: string;
  readonly name: string;
  readonly value: string;
}): void {
  if (!PORT_VAR_PATTERN.test(value)) {
    throw baseUrlVariableError(
      base,
      serviceName,
      name,
      "must be a numeric URL port",
    );
  }
}

function validateBaseUrlPathVariable({
  base,
  serviceName,
  name,
  value,
  prefix,
  suffix,
}: {
  readonly base: string;
  readonly serviceName: string;
  readonly name: string;
  readonly value: string;
  readonly prefix: string;
  readonly suffix: string;
}): void {
  for (const char of value) {
    if (PATH_VAR_STRUCTURE_CHARS.has(char)) {
      throw baseUrlVariableError(
        base,
        serviceName,
        name,
        "must not introduce path structure",
      );
    }
  }
  const decoded = validateBaseUrlVariablePercentEncoding({
    base,
    serviceName,
    name,
    value,
    structureChars: PATH_VAR_STRUCTURE_CHARS,
  });
  const prefixSegment = prefix.slice(prefix.lastIndexOf("/") + 1);
  const suffixSegmentEnd = suffix.search(URL_COMPONENT_DELIMITER_PATTERN);
  const suffixSegment =
    suffixSegmentEnd === -1 ? suffix : suffix.slice(0, suffixSegmentEnd);
  validateBaseUrlPathSegment({
    base,
    serviceName,
    name,
    segment: `${prefixSegment}${decoded}${suffixSegment}`,
  });
}

function prefixIsInsideAuthority(prefix: string): boolean {
  const schemeEnd = prefix.indexOf("://");
  if (schemeEnd === -1) return false;
  const afterScheme = prefix.slice(schemeEnd + 3);
  return !URL_COMPONENT_DELIMITER_PATTERN.test(afterScheme);
}

function prefixIsInsidePath(prefix: string): boolean {
  const schemeEnd = prefix.indexOf("://");
  if (schemeEnd === -1) return false;
  const afterScheme = prefix.slice(schemeEnd + 3);
  if (afterScheme.includes("?") || afterScheme.includes("#")) return false;
  return afterScheme.includes("/");
}

function suffixAuthorityPrefix(suffix: string): string {
  const delimiterIndex = suffix.search(URL_COMPONENT_DELIMITER_PATTERN);
  return delimiterIndex === -1 ? suffix : suffix.slice(0, delimiterIndex);
}

function authoritySuffixHasFixedHostOwnership(
  authoritySuffix: string,
): boolean {
  const hostSuffix = authoritySuffix
    .replace(/^[.]+/u, "")
    .replace(/:\d*$/u, "");
  const labels = hostSuffix.split(".").filter((label) => {
    return label !== "";
  });
  return labels.length >= 2;
}

function validateBaseUrlTemplateVariable({
  base,
  serviceName,
  name,
  value,
  prefix,
  suffix,
}: {
  readonly base: string;
  readonly serviceName: string;
  readonly name: string;
  readonly value: string;
  readonly prefix: string;
  readonly suffix: string;
}): void {
  validateBaseUrlVariableCommonSyntax({ base, serviceName, name, value });
  if (prefix === "" && suffix === "") {
    return;
  }
  if (prefix === "" && suffix.startsWith("/")) {
    validateBaseUrlPrefixVariable({ base, serviceName, name, value });
    return;
  }
  if (prefix.endsWith("://") && (suffix === "" || suffix.startsWith("/"))) {
    validateBaseUrlAuthorityVariable({ base, serviceName, name, value });
    return;
  }
  if (
    prefixIsInsideAuthority(prefix) &&
    prefix.endsWith(":") &&
    (suffix === "" || suffix.startsWith("/"))
  ) {
    validateBaseUrlPortVariable({ base, serviceName, name, value });
    return;
  }
  if (prefixIsInsideAuthority(prefix)) {
    validateBaseUrlAuthorityFragmentVariable({
      base,
      serviceName,
      name,
      value,
    });
    return;
  }
  if (prefixIsInsidePath(prefix)) {
    validateBaseUrlPathVariable({
      base,
      serviceName,
      name,
      value,
      prefix,
      suffix,
    });
    return;
  }
  throw baseUrlVariableError(
    base,
    serviceName,
    name,
    "is used in an unsupported base URL template position",
  );
}

export function firewallAuthInjectsCredentials(
  auth: FirewallApi["auth"],
): boolean {
  return (
    Object.keys(auth.headers ?? {}).length > 0 ||
    Object.keys(auth.query ?? {}).length > 0 ||
    Object.keys(auth.awsSigv4 ?? {}).length > 0 ||
    (typeof auth.base === "string" && auth.base.length > 0)
  );
}

function baseUrlScheme(base: string): string {
  const schemeEnd = base.indexOf("://");
  if (schemeEnd === -1) return "";
  return base.slice(0, schemeEnd).toLowerCase();
}

export function firewallBaseUrlTemplateNeedsHostPolicy(base: string): boolean {
  if (!hasBaseUrlVars(base)) return false;

  for (const match of base.matchAll(BASE_URL_VARS_PATTERN_G)) {
    const fullMatch = match[0];
    const matchIndex = match.index!;
    const prefix = base.slice(0, matchIndex);
    const suffix = base.slice(matchIndex + fullMatch.length);
    if (prefix === "" && (suffix === "" || suffix.startsWith("/"))) {
      return true;
    }
    if (prefix.endsWith("://")) {
      const authoritySuffix = suffixAuthorityPrefix(suffix);
      if (
        authoritySuffix === "" ||
        !authoritySuffixHasFixedHostOwnership(authoritySuffix)
      ) {
        return true;
      }
    }
    if (prefixIsInsideAuthority(prefix) && !prefix.endsWith(":")) {
      const authoritySuffix = suffixAuthorityPrefix(suffix);
      if (
        authoritySuffix === "" ||
        !authoritySuffixHasFixedHostOwnership(authoritySuffix)
      ) {
        return true;
      }
    }
  }

  return false;
}

function validateCredentialedBaseUrlTransportValue(
  base: string,
  serviceName: string,
  credentialed: boolean,
): void {
  if (!credentialed) return;
  if (baseUrlScheme(base) === REQUIRED_AUTH_BASE_URL_SCHEME) return;
  throw new Error(
    `Invalid base URL "${base}" in firewall "${serviceName}": credentialed base URL must use https`,
  );
}

function normalizeHostPolicyHostname(hostname: string): string {
  let normalized = hostname
    .replace(HOST_DOT_EQUIVALENT_PATTERN, ".")
    .toLowerCase();
  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function normalizeHostPolicySuffix(suffix: string): string {
  const withoutLeadingDot = suffix.startsWith(".") ? suffix.slice(1) : suffix;
  return normalizeHostPolicyHostname(withoutLeadingDot);
}

function parseCanonicalIpv4Address(value: string): readonly number[] | null {
  if (!isCanonicalIpv4Address(value)) {
    return null;
  }
  return value.split(".").map((part) => {
    return Number(part);
  });
}

function ipv4PartsToNumber(parts: readonly number[]): number | null {
  if (parts.length !== 4) {
    return null;
  }
  return parts.reduce((acc, part) => {
    return acc * IPV4_OCTET_BASE + part;
  }, 0);
}

function isPublicIpv4Address(parts: readonly number[]): boolean {
  const value = ipv4PartsToNumber(parts);
  if (value === null) {
    return false;
  }
  return !IPV4_NON_PUBLIC_RANGES.some(([start, end]) => {
    return value >= start && value <= end;
  });
}

function parseIpv6Word(value: string): number | null {
  if (
    value === "" ||
    value.length > 4 ||
    ![...value].every((char) => {
      return isHexDigit(char);
    })
  ) {
    return null;
  }
  return Number.parseInt(value, 16);
}

function parseIpv6WordList(value: string): readonly number[] | null {
  if (value === "") {
    return [];
  }
  const words: number[] = [];
  for (const part of value.split(":")) {
    const word = parseIpv6Word(part);
    if (word === null) {
      return null;
    }
    words.push(word);
  }
  return words;
}

function parseIpv6Address(value: string): readonly number[] | null {
  if (value.includes("%")) {
    return null;
  }

  let normalized = value.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon === -1) {
      return null;
    }
    const ipv4Parts = parseCanonicalIpv4Address(
      normalized.slice(lastColon + 1),
    );
    if (!ipv4Parts) {
      return null;
    }
    const highWord = (ipv4Parts[0]! << 8) + ipv4Parts[1]!;
    const lowWord = (ipv4Parts[2]! << 8) + ipv4Parts[3]!;
    normalized = `${normalized.slice(0, lastColon)}:${highWord.toString(16)}:${lowWord.toString(16)}`;
  }

  const compressed = normalized.split("::");
  if (compressed.length > 2) {
    return null;
  }

  const left = parseIpv6WordList(compressed[0]!);
  const right =
    compressed.length === 2 ? parseIpv6WordList(compressed[1]!) : [];
  if (!left || !right) {
    return null;
  }

  if (compressed.length === 1) {
    return left.length === 8 ? left : null;
  }

  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) {
    return null;
  }
  return [
    ...left,
    ...Array.from({ length: zeroCount }, () => {
      return 0;
    }),
    ...right,
  ];
}

function isPublicIpv6SpecialRegistryException(
  words: readonly number[],
): boolean {
  const second = words[1]!;
  if (
    second === IPV6_SPECIAL_EXACT_SECOND &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0 &&
    words[6] === 0 &&
    words[7]! >= IPV6_SPECIAL_EXACT_LAST_MIN &&
    words[7]! <= IPV6_SPECIAL_EXACT_LAST_MAX
  ) {
    return true;
  }
  if (second === IPV6_AMT_SECOND) {
    return true;
  }
  if (second === IPV6_AS112_SECOND && words[2] === IPV6_AS112_THIRD) {
    return true;
  }
  if (second >= IPV6_ORCHID_SECOND_MIN && second <= IPV6_ORCHID_SECOND_MAX) {
    return true;
  }
  return (
    second >= IPV6_DRONE_REMOTE_ID_SECOND_MIN &&
    second <= IPV6_DRONE_REMOTE_ID_SECOND_MAX
  );
}

function isPublicIpv6Address(words: readonly number[]): boolean {
  if (words.length !== 8) {
    return false;
  }
  const first = words[0]!;
  const second = words[1]!;
  if (
    first < IPV6_GLOBAL_UNICAST_FIRST_MIN ||
    first > IPV6_GLOBAL_UNICAST_FIRST_MAX
  ) {
    return false;
  }
  if (
    first === IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST &&
    second <= IPV6_IETF_PROTOCOL_ASSIGNMENTS_SECOND_MAX
  ) {
    return isPublicIpv6SpecialRegistryException(words);
  }
  if (
    first === IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST &&
    second === IPV6_DOCUMENTATION_SECOND
  ) {
    return false;
  }
  if (
    first === IPV6_EXPANDED_DOCUMENTATION_FIRST &&
    second <= IPV6_EXPANDED_DOCUMENTATION_SECOND_MAX
  ) {
    return false;
  }
  if (first === IPV6_6TO4_FIRST) {
    return false;
  }
  return true;
}

function hostPolicyIpLiteralIsPublic(hostname: string): boolean | null {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const words = parseIpv6Address(hostname.slice(1, -1));
    return words ? isPublicIpv6Address(words) : false;
  }

  const ipv4Parts = parseCanonicalIpv4Address(hostname);
  if (ipv4Parts) {
    return isPublicIpv4Address(ipv4Parts);
  }

  const normalizedIpv4Host = normalizeHostForIpv4LiteralSyntax(hostname);
  if (isIpv4LiteralLike(normalizedIpv4Host)) {
    return false;
  }
  return null;
}

function providerOwnedHostMatches(
  hostname: string,
  hostPolicy: Extract<
    FirewallBaseHostPolicy,
    { readonly kind: "providerOwned" }
  >,
  options: { readonly allowExactHosts?: boolean } = {},
): boolean {
  if (options.allowExactHosts !== false) {
    const exactHosts = hostPolicy.exactHosts ?? [];
    for (const exactHost of exactHosts) {
      if (hostname === normalizeHostPolicyHostname(exactHost)) {
        return true;
      }
    }
  }

  const suffixes = hostPolicy.suffixes ?? [];
  for (const suffix of suffixes) {
    const normalizedSuffix = normalizeHostPolicySuffix(suffix);
    if (
      normalizedSuffix !== "" &&
      hostname.length > normalizedSuffix.length &&
      hostname.endsWith(`.${normalizedSuffix}`)
    ) {
      return true;
    }
  }
  return false;
}

function baseUrlAuthorityHasParams(base: string): boolean {
  const authority = rawAuthorityFromBaseUrl(base);
  return authority !== null && hasBaseUrlParams(authority);
}

function validateHostPolicyShape(
  base: string,
  serviceName: string,
  hostPolicy: FirewallBaseHostPolicy,
): void {
  const result = firewallBaseHostPolicySchema.safeParse(hostPolicy);
  if (result.success) return;

  const message = result.error.issues
    .map((issue) => {
      return issue.message;
    })
    .join("; ");
  throw new Error(
    errMsg(base, serviceName, `hostPolicy is invalid: ${message}`),
  );
}

interface HostPolicyValidationUrl {
  readonly hostname: string;
  readonly port: string;
}

function urlForHostPolicyValidation(
  base: string,
  serviceName: string,
): HostPolicyValidationUrl {
  const authority = rawAuthorityFromBaseUrl(base);
  if (authority === null) {
    const url = urlForCanonicalBaseSyntax(base);
    return { hostname: url.hostname, port: url.port };
  }
  const authorityParts = splitParameterizedAuthority(
    authority,
    base,
    serviceName,
  );
  const hostname = splitAuthorityHostSegments(authorityParts.normalizedHost)
    .map((segment) => {
      return hostSegmentForSyntaxValidation(segment, base, serviceName);
    })
    .join(".");
  const schemeEnd = base.indexOf("://");
  const scheme = schemeEnd === -1 ? "https" : base.slice(0, schemeEnd);
  const port = new URL(
    `${scheme}://validation-host.invalid${authorityParts.portSuffix}`,
  ).port;
  return { hostname, port };
}

export function validateBaseUrlHostPolicy({
  base,
  diagnosticBase = base,
  serviceName,
  hostPolicy,
}: {
  readonly base: string;
  readonly diagnosticBase?: string;
  readonly serviceName: string;
  readonly hostPolicy: FirewallBaseHostPolicy | undefined;
}): void {
  if (!hostPolicy) {
    return;
  }

  validateHostPolicyShape(diagnosticBase, serviceName, hostPolicy);
  if (hasBaseUrlVars(base)) {
    return;
  }

  const canonicalBase = canonicalizeFirewallBaseUrl(base, serviceName);
  const authorityHasParams = baseUrlAuthorityHasParams(canonicalBase);
  const url = urlForHostPolicyValidation(canonicalBase, serviceName);
  const rawAuthority = rawAuthorityFromBaseUrl(base);
  const hostname = normalizeHostPolicyHostname(url.hostname);
  if (hostPolicy.kind === "providerOwned") {
    if (
      !providerOwnedHostMatches(hostname, hostPolicy, {
        allowExactHosts: !authorityHasParams,
      })
    ) {
      throw new Error(
        errMsg(
          diagnosticBase,
          serviceName,
          `host policy does not allow resolved host "${hostname}"`,
        ),
      );
    }
    if (!hostPolicy.allowNonDefaultPort && url.port !== "") {
      throw new Error(
        errMsg(
          diagnosticBase,
          serviceName,
          "host policy does not allow non-default ports",
        ),
      );
    }
    return;
  }

  const publicDestinationHost =
    rawAuthority === null ? url.hostname : rawHostFromAuthority(rawAuthority);
  const publicIpLiteral = hostPolicyIpLiteralIsPublic(publicDestinationHost);
  if (publicIpLiteral === false) {
    throw new Error(
      errMsg(
        diagnosticBase,
        serviceName,
        `host policy does not allow non-public IP literal "${hostname}"`,
      ),
    );
  }
}

export interface ResolveFirewallBaseUrlTemplateOptions {
  readonly serviceName: string;
  readonly base: string;
  readonly vars: Record<string, string> | undefined;
  readonly credentialed?: boolean;
  readonly hostPolicy?: FirewallBaseHostPolicy;
}

export function resolveFirewallBaseUrlTemplate({
  serviceName,
  base,
  vars,
  credentialed = false,
  hostPolicy,
}: ResolveFirewallBaseUrlTemplateOptions): string {
  if (!hasBaseUrlVars(base)) return base;

  try {
    let resolved = "";
    let lastIndex = 0;
    for (const match of base.matchAll(BASE_URL_VARS_PATTERN_G)) {
      const fullMatch = match[0];
      const name = match[1]!;
      const matchIndex = match.index!;
      const value = vars?.[name];
      if (!value) {
        throw new FirewallBaseUrlResolutionError(
          `Firewall "${serviceName}" base URL requires variable "${name}" but it was not provided`,
        );
      }
      validateBaseUrlTemplateVariable({
        base,
        serviceName,
        name,
        value,
        prefix: base.slice(0, matchIndex),
        suffix: base.slice(matchIndex + fullMatch.length),
      });
      resolved += base.slice(lastIndex, matchIndex) + value;
      lastIndex = matchIndex + fullMatch.length;
    }
    resolved += base.slice(lastIndex);
    validateResolvedBaseUrlPathSafety(base, serviceName, resolved);
    const canonicalBase = canonicalizeFirewallBaseUrl(resolved, serviceName);
    validateCredentialedBaseUrlTransportValue(
      canonicalBase,
      serviceName,
      credentialed,
    );
    validateBaseUrlHostPolicy({
      base: resolved,
      diagnosticBase: base,
      serviceName,
      hostPolicy,
    });
    return canonicalBase;
  } catch (error) {
    if (error instanceof FirewallBaseUrlResolutionError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new FirewallBaseUrlResolutionError(error.message);
    }
    throw error;
  }
}

function canonicalAuthorityVariableValue(
  value: string,
  serviceName: string,
): string {
  const canonicalBase = canonicalizeFirewallBaseUrl(
    `https://${value}`,
    serviceName,
  );
  const authority = rawAuthorityFromBaseUrl(canonicalBase);
  if (authority === null) {
    throw new FirewallBaseUrlResolutionError(
      `Firewall "${serviceName}" base URL variable is not a valid authority`,
    );
  }
  return authority;
}

function canonicalHostFragmentVariableValue({
  base,
  serviceName,
  name,
  value,
}: {
  readonly base: string;
  readonly serviceName: string;
  readonly name: string;
  readonly value: string;
}): string {
  validateHostPercentEncoding(value, base, serviceName);
  validateHostHasNoUnsafeIdnaMappings(value, base, serviceName);
  validateHostHasNoRawWildcards(value, base, serviceName);
  try {
    return canonicalizeDnsHostForExecution(value, base, serviceName);
  } catch (error) {
    if (error instanceof Error) {
      throw new FirewallBaseUrlResolutionError(
        `Firewall "${serviceName}" base URL variable "${name}" is not a valid hostname`,
      );
    }
    throw error;
  }
}

function canonicalBaseUrlVariableValue({
  base,
  serviceName,
  name,
  value,
  prefix,
  suffix,
}: {
  readonly base: string;
  readonly serviceName: string;
  readonly name: string;
  readonly value: string;
  readonly prefix: string;
  readonly suffix: string;
}): string {
  validateBaseUrlTemplateVariable({
    base,
    serviceName,
    name,
    value,
    prefix,
    suffix,
  });
  if (prefix === "" && (suffix === "" || suffix.startsWith("/"))) {
    return canonicalizeFirewallBaseUrl(value, serviceName);
  }
  if (prefix.endsWith("://") && (suffix === "" || suffix.startsWith("/"))) {
    return canonicalAuthorityVariableValue(value, serviceName);
  }
  if (
    prefixIsInsideAuthority(prefix) &&
    prefix.endsWith(":") &&
    (suffix === "" || suffix.startsWith("/"))
  ) {
    return value;
  }
  if (prefixIsInsideAuthority(prefix)) {
    const schemeEnd = prefix.indexOf("://");
    const authorityPrefix = prefix.slice(schemeEnd + 3);
    const authoritySuffix = suffixAuthorityPrefix(suffix);
    const startsAtLabelBoundary =
      authorityPrefix === "" || authorityPrefix.endsWith(".");
    const endsAtLabelBoundary =
      authoritySuffix === "" ||
      authoritySuffix.startsWith(".") ||
      authoritySuffix.startsWith(":");
    if (!startsAtLabelBoundary || !endsAtLabelBoundary) {
      const decodedValue = validateBaseUrlVariablePercentEncoding({
        base,
        serviceName,
        name,
        value,
        structureChars: PERCENT_DECODED_BOUNDARY_CHARS,
      });
      if (isAscii(decodedValue)) return decodedValue.toLowerCase();
      throw new FirewallBaseUrlResolutionError(
        `Firewall "${serviceName}" base URL variable "${name}" cannot use a non-ASCII value inside a host label`,
      );
    }
    return canonicalHostFragmentVariableValue({
      base,
      serviceName,
      name,
      value,
    });
  }
  return value;
}

/**
 * Return the existing base-URL variable payload with hostname-bearing values
 * converted to the same canonical ASCII identity used by resolved firewalls.
 */
export function canonicalizeFirewallBaseUrlVarsForExecution(
  firewalls: Firewalls,
  vars: Record<string, string> | undefined,
): Record<string, string> {
  resolveFirewallBaseUrlVars(firewalls, vars);
  const canonicalVars: Record<string, string> = {};
  for (const firewall of firewalls) {
    for (const api of firewall.apis) {
      for (const match of api.base.matchAll(BASE_URL_VARS_PATTERN_G)) {
        const fullMatch = match[0];
        const name = match[1]!;
        const matchIndex = match.index!;
        const value = vars?.[name];
        if (!value) {
          throw new FirewallBaseUrlResolutionError(
            `Firewall "${firewall.name}" base URL requires variable "${name}" but it was not provided`,
          );
        }
        const canonicalValue = canonicalBaseUrlVariableValue({
          base: api.base,
          serviceName: firewall.name,
          name,
          value,
          prefix: api.base.slice(0, matchIndex),
          suffix: api.base.slice(matchIndex + fullMatch.length),
        });
        const previousValue = canonicalVars[name];
        if (previousValue !== undefined && previousValue !== canonicalValue) {
          throw new FirewallBaseUrlResolutionError(
            `Firewall "${firewall.name}" base URL variable "${name}" requires incompatible execution representations`,
          );
        }
        canonicalVars[name] = canonicalValue;
      }
    }
  }
  return canonicalVars;
}

/**
 * Resolve `${{ vars.X }}` templates in firewall base URLs.
 * Static definitions are trusted catalog input and returned unchanged. Dynamic
 * values are validated and hostname-bearing values use canonical ASCII.
 */
export function resolveFirewallBaseUrlVars(
  firewalls: Firewalls,
  vars: Record<string, string> | undefined,
): Firewalls {
  return firewalls.map((fw) => {
    return {
      ...fw,
      apis: fw.apis.map((api) => {
        if (!hasBaseUrlVars(api.base)) return api;
        const resolved = resolveFirewallBaseUrlTemplate({
          serviceName: fw.name,
          base: api.base,
          vars,
          credentialed: firewallAuthInjectsCredentials(api.auth),
          hostPolicy: api.hostPolicy,
        });
        return { ...api, base: resolved };
      }),
    };
  });
}

/**
 * Check if a base URL contains `{name}` style parameter placeholders
 * (as opposed to `${{ vars.X }}` template references).
 */
export function hasBaseUrlParams(base: string): boolean {
  // Strip ${{ ... }} template references, then check for remaining { }.
  // Uses string iteration instead of regex to avoid ReDoS risk.
  let stripped = base;
  let start = stripped.indexOf("${{");
  while (start !== -1) {
    const end = stripped.indexOf("}}", start + 3);
    if (end === -1) break;
    stripped = stripped.slice(0, start) + stripped.slice(end + 2);
    start = stripped.indexOf("${{");
  }
  return stripped.includes("{") && stripped.includes("}");
}

const HOST_WILDCARD_PARAM_PREFIX = "hostWildcard";

interface RawBaseUrlAuthority {
  readonly authority: string;
  readonly start: number;
  readonly end: number;
}

interface RawWildcardAuthorityParts {
  readonly host: string;
  readonly portSuffix: string;
}

function rawBaseUrlAuthorityRange(base: string): RawBaseUrlAuthority | null {
  const schemeEnd = base.indexOf("://");
  if (schemeEnd === -1) return null;
  const start = schemeEnd + 3;
  const rest = base.slice(start);
  const delimiterIndexes = [
    rest.indexOf("/"),
    rest.indexOf("?"),
    rest.indexOf("#"),
  ].filter((index) => {
    return index !== -1;
  });
  const end =
    delimiterIndexes.length === 0
      ? base.length
      : start + Math.min(...delimiterIndexes);
  return {
    authority: base.slice(start, end),
    start,
    end,
  };
}

function splitRawWildcardAuthority(
  authority: string,
): RawWildcardAuthorityParts | null {
  if (
    authority === "" ||
    authority.includes("@") ||
    authorityHasEmptyPort(authority)
  ) {
    return null;
  }

  if (authority.startsWith("[")) {
    return null;
  }

  const portSeparator = authority.lastIndexOf(":");
  if (portSeparator === -1) {
    return { host: authority, portSuffix: "" };
  }
  if (authority.indexOf(":") !== portSeparator) {
    return null;
  }
  return {
    host: authority.slice(0, portSeparator),
    portSuffix: authority.slice(portSeparator),
  };
}

/**
 * Convert user-facing `*` wildcards in a URL host into the existing
 * parameterized host grammar understood by the firewall matcher.
 *
 * Examples:
 *   - https://*.example.com/ -> https://{hostWildcard1}.example.com/
 *   - https://api-*.example.com/ -> https://api-{hostWildcard1}.example.com/
 *   - https://*.*.example.com/ -> https://{hostWildcard1}.{hostWildcard2}.example.com/
 *
 * Each `*` is a single host-label wildcard. Only the host is transformed.
 * Path `*` characters remain literal.
 */
export function expandHostWildcardsInBaseUrl(base: string): string {
  if (base.includes("\\")) {
    return base;
  }

  const authorityRange = rawBaseUrlAuthorityRange(base);
  if (authorityRange === null) {
    return base;
  }
  const authority = splitRawWildcardAuthority(authorityRange.authority);
  if (authority === null || !authority.host.includes("*")) return base;

  let paramIndex = 0;
  const host = authority.host
    .split(".")
    .map((segment) => {
      if (!segment.includes("*")) {
        return segment;
      }
      let expanded = "";
      for (let i = 0; i < segment.length; i++) {
        const ch = segment[i]!;
        if (ch === "*") {
          paramIndex += 1;
          expanded += `{${HOST_WILDCARD_PARAM_PREFIX}${paramIndex}}`;
        } else {
          expanded += ch;
        }
      }
      return expanded;
    })
    .join(".");

  return `${base.slice(0, authorityRange.start)}${host}${authority.portSuffix}${base.slice(
    authorityRange.end,
  )}`;
}

function errMsg(base: string, svc: string, detail: string): string {
  return `Invalid base URL "${base}" in firewall "${svc}": ${detail}`;
}

const HOST_DOT_EQUIVALENTS = new Set([".", "\u3002", "\uff0e", "\uff61"]);
const FORBIDDEN_NORMALIZED_LABEL_CHARS = new Set("#%,/:<>?@[\\]^|[]".split(""));
const ALLOWED_BASE_URL_SCHEMES = new Set(["http", "https"]);
const REQUIRED_AUTH_BASE_URL_SCHEME = "https";
const WHITESPACE_PATTERN = /\s/u;
const UNICODE_CONTROL_PATTERN = /\p{C}/u;
const UNICODE_DECIMAL_NUMBER_PATTERN = /^\p{Decimal_Number}+$/u;
const UNICODE_MARK_PATTERN = /\p{M}/u;
const UNICODE_LETTER_PATTERN = /\p{L}/u;
const GREEK_COMBINING_YPOGEGRAMMENI = "\u0345";
const GREEK_SMALL_IOTA = "\u03b9";
// WHATWG accepts these RTL-class label chars in places where Python's IDNA
// bidi validation rejects mixed LTR/RTL labels at runtime.
const IDNA_BIDI_RTL_LABEL_RANGES = [
  [0x061d, 0x061d],
  [0x0870, 0x088e],
  [0x08b5, 0x08b5],
  [0x08c8, 0x08c9],
  [0xfbc2, 0xfbc2],
  [0x10f70, 0x10f81],
  [0x10f86, 0x10f89],
] as const;
// Keep creation-time host validation aligned with mitm-addon host_normalization.py.
const UNSAFE_UTS46_COLLISION_CHARS = new Set([
  "\u03f2",
  "\u04c0",
  "\u1e9e",
  "\u1806",
  "\u2132",
  "\u2183",
  "\u3164",
  "\uffa0",
  "\ufffc",
  "\ufffd",
  "\u{2f868}",
  "\u{2f874}",
  "\u{2f91f}",
  "\u{2f95f}",
  "\u{2f9bf}",
]);
const UNSAFE_UTS46_COLLISION_RANGES = [
  [0x10a0, 0x10c5],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x2ff0, 0x2ffb],
] as const;
const UNSAFE_UTS46_IGNORABLE_RANGES = [
  [0x034f, 0x034f],
  [0x180b, 0x180d],
  [0x180f, 0x180f],
  [0xfe00, 0xfe0f],
  [0xe0100, 0xe01ef],
] as const;

interface ParameterizedAuthorityParts {
  readonly normalizedHost: string;
  readonly portSuffix: string;
}

function isHexDigit(char: string): boolean {
  return (
    (char >= "0" && char <= "9") ||
    (char >= "a" && char <= "f") ||
    (char >= "A" && char <= "F")
  );
}

function validateBaseUrlScheme(
  scheme: string,
  base: string,
  serviceName: string,
): void {
  if (!ALLOWED_BASE_URL_SCHEMES.has(scheme.toLowerCase())) {
    throw new Error(errMsg(base, serviceName, "scheme must be http or https"));
  }
}

function validateUrlSchemeDelimiter(
  value: string,
  serviceName: string,
  label: "base URL" | "auth.base URL",
  displayValue = value,
): void {
  if (value.includes("://")) return;

  const colonIndex = value.indexOf(":");
  if (colonIndex !== -1) {
    const scheme = value.slice(0, colonIndex);
    const schemeDetail =
      label === "auth.base URL"
        ? "scheme must be https"
        : "scheme must be http or https";
    const allowedScheme =
      label === "auth.base URL"
        ? scheme.toLowerCase() === REQUIRED_AUTH_BASE_URL_SCHEME
        : ALLOWED_BASE_URL_SCHEMES.has(scheme.toLowerCase());
    if (!allowedScheme) {
      throw new Error(
        `Invalid ${label} "${displayValue}" in firewall "${serviceName}": ${schemeDetail}`,
      );
    }
    throw new Error(
      `Invalid ${label} "${displayValue}" in firewall "${serviceName}": URL must include "://" after the scheme`,
    );
  }

  throw new Error(
    `Invalid ${label} "${displayValue}" in firewall "${serviceName}": URL must include a scheme (e.g. "https://${displayValue}")`,
  );
}

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function isIpv4NumberComponent(value: string): boolean {
  if (value === "") return false;
  if (value.toLowerCase().startsWith("0x")) {
    if (value.length <= 2) return false;
    for (let index = 2; index < value.length; index += 1) {
      if (!isHexDigit(value.charAt(index))) return false;
    }
    return true;
  }
  return UNICODE_DECIMAL_NUMBER_PATTERN.test(value);
}

function isIpv4LiteralLike(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length >= 1 && parts.length <= 4 && parts.every(isIpv4NumberComponent)
  );
}

function isCanonicalIpv4Address(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (
      part === "" ||
      ![...part].every((char) => {
        return char >= "0" && char <= "9";
      })
    ) {
      return false;
    }
    if (part.length > 1 && part.startsWith("0")) return false;
    return Number(part) <= IPV4_MAX_OCTET;
  });
}

function codePointInRanges(
  codePoint: number,
  ranges: readonly (readonly [number, number])[],
): boolean {
  return ranges.some(([start, end]) => {
    return start <= codePoint && codePoint <= end;
  });
}

function hasUnsafeUts46MappingChar(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (
      UNSAFE_UTS46_COLLISION_CHARS.has(char) ||
      (codePoint !== undefined &&
        (codePointInRanges(codePoint, UNSAFE_UTS46_COLLISION_RANGES) ||
          codePointInRanges(codePoint, UNSAFE_UTS46_IGNORABLE_RANGES)))
    ) {
      return true;
    }
  }
  return false;
}

function normalizesToAscii(value: string): boolean {
  return isAscii(normalizeLabelTextForIdnaValidation(value));
}

function normalizeLabelTextForIdnaValidation(value: string): string {
  return value
    .replaceAll(GREEK_COMBINING_YPOGEGRAMMENI, GREEK_SMALL_IOTA)
    .normalize("NFKD")
    .normalize("NFC")
    .toLowerCase();
}

function hasForbiddenNormalizedLabelChar(value: string): boolean {
  for (const char of normalizeLabelTextForIdnaValidation(value)) {
    if (
      FORBIDDEN_NORMALIZED_LABEL_CHARS.has(char) ||
      HOST_DOT_EQUIVALENTS.has(char) ||
      WHITESPACE_PATTERN.test(char) ||
      UNICODE_CONTROL_PATTERN.test(char)
    ) {
      return true;
    }
  }
  return false;
}

function normalizedLabelStartsWithMark(value: string): boolean {
  const [firstChar] = normalizeLabelTextForIdnaValidation(value);
  return firstChar !== undefined && UNICODE_MARK_PATTERN.test(firstChar);
}

function isIdnaBidiRtlLabelChar(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return (
    codePoint !== undefined &&
    codePointInRanges(codePoint, IDNA_BIDI_RTL_LABEL_RANGES)
  );
}

function isLtrLetterForBidiCheck(char: string): boolean {
  return UNICODE_LETTER_PATTERN.test(char) && !isIdnaBidiRtlLabelChar(char);
}

function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isArabicNumberForBidiCheck(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && 0x0660 <= codePoint && codePoint <= 0x0669;
}

function effectiveBidiEndChar(chars: readonly string[]): string | undefined {
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    if (!UNICODE_MARK_PATTERN.test(char)) return char;
  }
  return chars.at(-1);
}

function firstEffectiveBidiChar(chars: readonly string[]): string | undefined {
  return chars.find((char) => {
    return !UNICODE_MARK_PATTERN.test(char);
  });
}

function isRtlEndCharForBidiCheck(char: string): boolean {
  return (
    isIdnaBidiRtlLabelChar(char) ||
    isAsciiDigit(char) ||
    isArabicNumberForBidiCheck(char)
  );
}

function hasInvalidMixedBidiLabelText(value: string): boolean {
  const chars = Array.from(normalizeLabelTextForIdnaValidation(value));
  const firstRtlIndex = chars.findIndex((char) => {
    return isIdnaBidiRtlLabelChar(char);
  });
  if (firstRtlIndex === -1) return false;

  const suffix = chars.slice(firstRtlIndex + 1);
  if (firstRtlIndex === 0) {
    const suffixHasLtrLetter = suffix.some((char) => {
      return isLtrLetterForBidiCheck(char);
    });
    if (suffixHasLtrLetter) return true;

    const endChar = effectiveBidiEndChar(chars);
    return endChar !== undefined && !isRtlEndCharForBidiCheck(endChar);
  }

  const suffixHasLtrLetter = suffix.some((char) => {
    return isLtrLetterForBidiCheck(char);
  });
  if (suffixHasLtrLetter) return true;

  const prefix = chars.slice(0, firstRtlIndex);
  const prefixHasLtrLetter = prefix.some((char) => {
    return isLtrLetterForBidiCheck(char);
  });
  if (prefixHasLtrLetter) {
    if (prefix.some(isArabicNumberForBidiCheck)) return true;
    const firstPrefixChar = firstEffectiveBidiChar(prefix);
    if (
      firstPrefixChar === undefined ||
      !isLtrLetterForBidiCheck(firstPrefixChar)
    ) {
      return true;
    }
    return suffix.some((char) => {
      return !UNICODE_MARK_PATTERN.test(char);
    });
  }

  const endChar = effectiveBidiEndChar(chars);
  return endChar !== undefined && !isRtlEndCharForBidiCheck(endChar);
}

function baseUrlRawSyntaxTarget(base: string): string {
  return base.replace(BASE_URL_VARS_PATTERN_G, AUTH_TEMPLATE_URL_PLACEHOLDER);
}

function validateDecodedHostPercentCharacters(
  decoded: string,
  base: string,
  serviceName: string,
): void {
  for (const char of decoded) {
    const codeUnit = char.charCodeAt(0);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) {
      throw new Error(
        errMsg(
          base,
          serviceName,
          "host must not contain percent-encoded control characters or whitespace",
        ),
      );
    }
    if (PERCENT_DECODED_BOUNDARY_CHARS.has(char)) {
      throw new Error(
        errMsg(
          base,
          serviceName,
          "host must not contain percent-encoded URL structure",
        ),
      );
    }
    if (char === "%") {
      throw new Error(
        errMsg(
          base,
          serviceName,
          "host must not contain percent-encoded percent",
        ),
      );
    }
    if (char === "{" || char === "}") {
      throw new Error(
        errMsg(
          base,
          serviceName,
          "host must not contain percent-encoded braces",
        ),
      );
    }
    if (HOST_DOT_EQUIVALENTS.has(char)) {
      throw new Error(
        errMsg(base, serviceName, "host must not contain percent-encoded dots"),
      );
    }
    if (char === ",") {
      throw new Error(
        errMsg(base, serviceName, "host must not contain commas"),
      );
    }
    if (char === "*") {
      throw new Error(
        errMsg(base, serviceName, "host must not contain wildcard characters"),
      );
    }
  }
}

function validateHostPercentEncoding(
  host: string,
  base: string,
  serviceName: string,
): void {
  if (host.includes(",")) {
    throw new Error(errMsg(base, serviceName, "host must not contain commas"));
  }
  for (let i = 0; i < host.length; i += 1) {
    if (host[i] !== "%") continue;
    if (
      i + 2 >= host.length ||
      !isHexDigit(host[i + 1]!) ||
      !isHexDigit(host[i + 2]!)
    ) {
      throw new Error(
        errMsg(base, serviceName, "host has invalid percent encoding"),
      );
    }

    let end = i;
    while (
      end + 2 < host.length &&
      host[end] === "%" &&
      isHexDigit(host[end + 1]!) &&
      isHexDigit(host[end + 2]!)
    ) {
      end += 3;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(host.slice(i, end));
    } catch {
      throw new Error(
        errMsg(base, serviceName, "host has invalid percent encoding"),
      );
    }
    validateDecodedHostPercentCharacters(decoded, base, serviceName);
    i = end - 1;
  }
  if (host.includes("%")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(host);
    } catch {
      throw new Error(
        errMsg(base, serviceName, "host has invalid percent encoding"),
      );
    }
    validateHostHasNoUnsafeIdnaMappings(decoded, base, serviceName);
  }
}

function rawAuthorityFromBaseUrl(base: string): string | null {
  const schemeEnd = base.indexOf("://");
  if (schemeEnd === -1) return null;
  const rest = base.slice(schemeEnd + 3);
  const delimiterIndexes = [
    rest.indexOf("/"),
    rest.indexOf("?"),
    rest.indexOf("#"),
  ].filter((index) => {
    return index !== -1;
  });
  const authorityEnd =
    delimiterIndexes.length === 0 ? -1 : Math.min(...delimiterIndexes);
  return authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
}

function authorityHasEmptyPort(authority: string): boolean {
  if (authority.startsWith("[")) {
    const closeBracket = authority.indexOf("]");
    if (closeBracket === -1) return false;
    return authority.slice(closeBracket + 1) === ":";
  }

  const portSeparator = authority.lastIndexOf(":");
  if (portSeparator === -1) return false;
  return (
    authority.indexOf(":") === portSeparator &&
    portSeparator === authority.length - 1
  );
}

function validateNoUserinfo(
  authority: string,
  base: string,
  serviceName: string,
): void {
  if (authority.includes("@")) {
    throw new Error(errMsg(base, serviceName, "must not contain userinfo"));
  }
}

function validateHostHasNoEmptyLabels(
  host: string,
  base: string,
  serviceName: string,
): string {
  let normalizedHost = host.replace(HOST_DOT_EQUIVALENT_PATTERN, ".");
  if (normalizedHost.endsWith(".")) {
    normalizedHost = normalizedHost.slice(0, -1);
  }
  if (
    normalizedHost === "" ||
    normalizedHost.endsWith(".") ||
    normalizedHost.split(".").some((label) => {
      return label === "";
    })
  ) {
    throw new Error(
      errMsg(base, serviceName, "host must not contain empty labels"),
    );
  }
  return normalizedHost;
}

function normalizeHostForIpv4LiteralSyntax(host: string): string {
  let normalized = host.replace(HOST_DOT_EQUIVALENT_PATTERN, ".").toLowerCase();
  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function rawHostForCanonicalIpv4Syntax(host: string): string {
  const normalized = host.toLowerCase();
  return normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
}

function splitAuthorityHostSegments(host: string): string[] {
  if (host.startsWith("[") && host.endsWith("]")) {
    return [host];
  }
  return host.split(".");
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

function canonicalizeDnsHostForExecution(
  rawHost: string,
  base: string,
  serviceName: string,
): string {
  if (rawHost.startsWith("[") && rawHost.endsWith("]")) {
    return rawHost.toLowerCase();
  }
  const normalizedHost = validateHostHasNoEmptyLabels(
    rawHost,
    base,
    serviceName,
  );
  let decodedHost: string;
  try {
    decodedHost = decodeURIComponent(normalizedHost);
  } catch {
    throw new Error(
      errMsg(base, serviceName, "host has invalid percent encoding"),
    );
  }
  for (const char of decodedHost) {
    if (DNS_HOST_FORBIDDEN_ASCII_CHARS.has(char)) {
      throw new Error(
        errMsg(base, serviceName, "host contains a forbidden ASCII character"),
      );
    }
  }
  const canonicalHost = canonicalizeFirewallDnsHostname(decodedHost);
  if (canonicalHost === null || canonicalHost === "") {
    throw new Error(
      errMsg(
        base,
        serviceName,
        `host is not valid under hostname policy ${FIREWALL_HOSTNAME_POLICY_VERSION}`,
      ),
    );
  }
  validateHostHasNoEmptyLabels(canonicalHost, base, serviceName);
  return canonicalHost;
}

function canonicalizeAuthorityForExecution(
  authority: string,
  base: string,
  serviceName: string,
): string {
  const rawHost = rawHostFromAuthority(authority);
  if (rawHost.startsWith("[") && rawHost.endsWith("]")) {
    return `${rawHost.toLowerCase()}${authority.slice(rawHost.length)}`;
  }
  const canonicalHost = canonicalizeDnsHostForExecution(
    rawHost,
    base,
    serviceName,
  );
  return `${canonicalHost}${authority.slice(rawHost.length)}`;
}

function baseWithAuthority(base: string, authority: string): string {
  const schemeEnd = base.indexOf("://");
  const rawAuthority = rawAuthorityFromBaseUrl(base);
  if (schemeEnd === -1 || rawAuthority === null) {
    return base;
  }
  const authorityStart = schemeEnd + 3;
  return `${base.slice(0, authorityStart)}${authority}${base.slice(
    authorityStart + rawAuthority.length,
  )}`;
}

function authorityForUrlSyntaxValidation(authority: string): string {
  const rawHost = rawHostFromAuthority(authority);
  if (rawHost.startsWith("[") && rawHost.endsWith("]")) {
    return authority;
  }
  return `validation-host.invalid${authority.slice(rawHost.length)}`;
}

function urlForCanonicalBaseSyntax(base: string): URL {
  const authority = rawAuthorityFromBaseUrl(base);
  return new URL(
    authority === null
      ? base
      : baseWithAuthority(base, authorityForUrlSyntaxValidation(authority)),
  );
}

function validateLabelHasNoUnsafeIdnaMappings(
  label: string,
  base: string,
  serviceName: string,
): void {
  const parsed = parseSegment(label);
  const value =
    parsed.kind === "param" ? `${parsed.prefix}${parsed.suffix}` : label;
  if (value === "" || isAscii(value)) return;
  if (hasForbiddenNormalizedLabelChar(value)) {
    throw new Error(
      errMsg(
        base,
        serviceName,
        "host must not contain characters that normalize to forbidden host syntax",
      ),
    );
  }
  if (normalizedLabelStartsWithMark(value)) {
    throw new Error(
      errMsg(
        base,
        serviceName,
        "host label must not start with a combining mark",
      ),
    );
  }
  if (hasInvalidMixedBidiLabelText(value)) {
    throw new Error(
      errMsg(
        base,
        serviceName,
        "host must not contain invalid bidirectional label text",
      ),
    );
  }
  if (hasUnsafeUts46MappingChar(value) || normalizesToAscii(value)) {
    throw new Error(
      errMsg(
        base,
        serviceName,
        "host must not contain unsafe IDNA compatibility mappings",
      ),
    );
  }
}

function validateHostHasNoUnsafeIdnaMappings(
  authorityOrHost: string,
  base: string,
  serviceName: string,
): void {
  const host = rawHostFromAuthority(authorityOrHost);
  if (host.startsWith("[") && host.endsWith("]")) return;
  for (const label of host
    .replace(HOST_DOT_EQUIVALENT_PATTERN, ".")
    .split(".")) {
    validateLabelHasNoUnsafeIdnaMappings(label, base, serviceName);
  }
}

function validateHostHasCanonicalIpv4Syntax(
  authorityOrHost: string,
  base: string,
  serviceName: string,
): void {
  const host = rawHostFromAuthority(authorityOrHost);
  if (host.startsWith("[") && host.endsWith("]")) return;
  const normalizedHost = normalizeHostForIpv4LiteralSyntax(host);
  if (
    isIpv4LiteralLike(normalizedHost) &&
    (rawHostForCanonicalIpv4Syntax(host) !== normalizedHost ||
      !isCanonicalIpv4Address(normalizedHost))
  ) {
    throw new Error(
      errMsg(base, serviceName, "host must use canonical IPv4 address syntax"),
    );
  }
}

function splitParameterizedAuthority(
  authority: string,
  base: string,
  serviceName: string,
): ParameterizedAuthorityParts {
  let host = authority;
  let portSuffix = "";
  if (authority.startsWith("[")) {
    const closeBracket = authority.indexOf("]");
    if (closeBracket === -1) {
      throw new Error(errMsg(base, serviceName, "not a valid URL authority"));
    }
    host = authority.slice(0, closeBracket + 1);
    portSuffix = authority.slice(closeBracket + 1);
    if (portSuffix !== "" && !portSuffix.startsWith(":")) {
      throw new Error(errMsg(base, serviceName, "not a valid URL authority"));
    }
  } else {
    const portSeparator = authority.lastIndexOf(":");
    if (portSeparator !== -1) {
      host = authority.slice(0, portSeparator);
      portSuffix = authority.slice(portSeparator);
    }
  }

  const normalizedHost = validateHostHasNoEmptyLabels(host, base, serviceName);

  return { normalizedHost, portSuffix };
}

function validateStaticHostLabels(
  hostname: string,
  base: string,
  serviceName: string,
): void {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return;
  validateHostHasNoEmptyLabels(hostname, base, serviceName);
  validateHostHasNoRawWildcards(hostname, base, serviceName);
}

function hostSegmentHasRawWildcard(segment: string): boolean {
  const parsed = parseSegment(segment);
  if (parsed.kind === "literal") return parsed.value.includes("*");
  if (parsed.kind === "param") {
    return parsed.prefix.includes("*") || parsed.suffix.includes("*");
  }
  return false;
}

function validateHostHasNoRawWildcards(
  host: string,
  base: string,
  serviceName: string,
): void {
  if (host.startsWith("[") && host.endsWith("]")) return;
  for (const segment of host
    .replace(HOST_DOT_EQUIVALENT_PATTERN, ".")
    .split(".")) {
    if (hostSegmentHasRawWildcard(segment)) {
      throw new Error(
        errMsg(base, serviceName, "host must not contain wildcard characters"),
      );
    }
  }
}

function hostSegmentForSyntaxValidation(
  seg: string,
  base: string,
  svc: string,
): string {
  const parsed = parseSegment(seg);
  if (parsed.kind === "literal") return seg;
  if (parsed.kind === "error") {
    throw new Error(errMsg(base, svc, parsed.reason));
  }
  if (!isAscii(parsed.prefix) || !isAscii(parsed.suffix)) {
    throw new Error(
      errMsg(
        base,
        svc,
        `host parameter segment "${seg}" must use ASCII literal prefix and suffix`,
      ),
    );
  }
  return `${parsed.prefix}x${parsed.suffix}`;
}

function validateParameterizedHostUrlSyntax(
  scheme: string,
  authority: ParameterizedAuthorityParts,
  base: string,
  serviceName: string,
): void {
  const syntaxHost = splitAuthorityHostSegments(authority.normalizedHost)
    .map((seg) => {
      hostSegmentForSyntaxValidation(seg, base, serviceName);
      const parsed = parseSegment(seg);
      if (parsed.kind === "error") {
        throw new Error(errMsg(base, serviceName, parsed.reason));
      }
      return "x";
    })
    .join(".");
  try {
    new URL(`${scheme}://${syntaxHost}${authority.portSuffix}`);
  } catch {
    throw new Error(errMsg(base, serviceName, "not a valid URL authority"));
  }
}

/**
 * Validate host segments (`.`-delimited) for parameterized base URLs.
 * Greedy params (`+`/`*`) must be the first (leftmost) host segment and
 * must not appear in mixed segments (prefix/suffix).
 * At least one pure-literal segment is required for security — a mixed
 * segment carrying a parameter is NOT counted as static.
 */
function validateHostParams(
  segments: string[],
  paramNames: Set<string>,
  base: string,
  svc: string,
): void {
  if (segments.length < 2) {
    throw new Error(errMsg(base, svc, "host must have at least two segments"));
  }
  let hasStatic = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") {
      throw new Error(errMsg(base, svc, parsed.reason));
    }
    if (parsed.kind === "literal") {
      hasStatic = true;
      continue;
    }
    const { name, greedy, prefix, suffix } = parsed;
    if (paramNames.has(name)) {
      throw new Error(
        errMsg(base, svc, `duplicate parameter name "{${name}}" in host`),
      );
    }
    paramNames.add(name);
    if (greedy && i !== 0) {
      throw new Error(
        errMsg(base, svc, `{${name}${greedy}} must be the first host segment`),
      );
    }
    if (greedy && (prefix !== "" || suffix !== "")) {
      throw new Error(
        errMsg(
          base,
          svc,
          `greedy parameter {${name}${greedy}} cannot be combined with a literal prefix or suffix in host segment "${seg}"`,
        ),
      );
    }
  }
  if (!hasStatic) {
    throw new Error(
      errMsg(base, svc, "host must have at least one static segment"),
    );
  }
}

/**
 * Validate path segments (`/`-delimited) for parameterized base URLs.
 * Greedy params (`+`/`*`) are rejected — they would consume the entire
 * remaining path, leaving nothing for permission rules to match against.
 * Mixed segments (`{param}.ext`, `prefix-{param}`) are accepted.
 */
function validatePathParams(
  segments: string[],
  paramNames: Set<string>,
  base: string,
  svc: string,
): void {
  for (const seg of segments) {
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") {
      throw new Error(errMsg(base, svc, parsed.reason));
    }
    if (parsed.kind === "literal") continue;
    const { name, greedy } = parsed;
    if (greedy) {
      throw new Error(
        errMsg(
          base,
          svc,
          `greedy parameter {${name}${greedy}} is not allowed in base URL path`,
        ),
      );
    }
    if (paramNames.has(name)) {
      throw new Error(
        errMsg(base, svc, `duplicate parameter name "{${name}}"`),
      );
    }
    paramNames.add(name);
  }
}

/**
 * Validate parameter segments in a firewall base URL.
 *
 * Host portion: `{param}`, `{param+}`, `{param*}` allowed.
 *   - Greedy (`+`/`*`) must be in the leftmost (first) host segment.
 *   - At least one static host segment is required for security.
 *
 * Path portion: only `{param}` (single-segment) allowed.
 *   - Greedy (`+`/`*`) is rejected — it would consume the entire remaining
 *     path, leaving nothing for permission rules to match against.
 */
function validateBaseUrlParams(base: string, serviceName: string): string {
  const schemeEnd = base.indexOf("://");
  if (schemeEnd === -1) {
    throw new Error(errMsg(base, serviceName, "missing scheme"));
  }
  const scheme = base.slice(0, schemeEnd);
  if (scheme.includes("{")) {
    throw new Error(
      errMsg(base, serviceName, "scheme must not contain parameters"),
    );
  }
  validateBaseUrlScheme(scheme, base, serviceName);
  if (base.includes("?")) {
    throw new Error(errMsg(base, serviceName, "must not contain query string"));
  }
  if (base.includes("#")) {
    throw new Error(errMsg(base, serviceName, "must not contain fragment"));
  }

  const rest = base.slice(schemeEnd + 3);
  const slashIdx = rest.indexOf("/");
  const host = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const path = slashIdx === -1 ? "" : rest.slice(slashIdx);
  if (authorityHasEmptyPort(host)) {
    throw new Error(errMsg(base, serviceName, "not a valid URL authority"));
  }
  validateNoUserinfo(host, base, serviceName);
  validateHostPercentEncoding(host, base, serviceName);
  const authority = splitParameterizedAuthority(host, base, serviceName);
  validateHostHasCanonicalIpv4Syntax(
    authority.normalizedHost,
    base,
    serviceName,
  );
  validateHostHasNoUnsafeIdnaMappings(
    authority.normalizedHost,
    base,
    serviceName,
  );
  validateHostHasNoRawWildcards(authority.normalizedHost, base, serviceName);
  const canonicalAuthority = {
    normalizedHost: splitAuthorityHostSegments(authority.normalizedHost)
      .map((segment) => {
        const parsed = parseSegment(segment);
        if (parsed.kind === "error") {
          throw new Error(errMsg(base, serviceName, parsed.reason));
        }
        if (parsed.kind === "param") {
          canonicalizeDnsHostForExecution(
            `${parsed.prefix}x${parsed.suffix}`,
            base,
            serviceName,
          );
          return segment;
        }
        const canonicalSegment = canonicalizeDnsHostForExecution(
          segment,
          base,
          serviceName,
        );
        if (
          !canonicalSegment.startsWith("[") &&
          canonicalSegment.includes(".")
        ) {
          throw new Error(
            errMsg(
              base,
              serviceName,
              "host label must not map to multiple labels",
            ),
          );
        }
        return canonicalSegment;
      })
      .join("."),
    portSuffix: authority.portSuffix,
  };
  const canonicalHostSegments = splitAuthorityHostSegments(
    canonicalAuthority.normalizedHost,
  );
  const parsedHostSegments = canonicalHostSegments.map(parseSegment);
  const minimumHostSegments = parsedHostSegments.filter((segment) => {
    return segment.kind !== "param" || segment.greedy !== "*";
  }).length;
  if (
    hasBaseUrlParams(canonicalAuthority.normalizedHost) &&
    minimumHostSegments <= 4 &&
    parsedHostSegments.some((segment) => {
      return segment.kind === "literal" && isIpv4NumberComponent(segment.value);
    }) &&
    parsedHostSegments.every((segment) => {
      return (
        (segment.kind === "literal" && isIpv4NumberComponent(segment.value)) ||
        (segment.kind === "param" &&
          /^[0-9]*$/.test(segment.prefix + segment.suffix))
      );
    })
  ) {
    throw new Error(errMsg(base, serviceName, "not a valid URL authority"));
  }
  validateParameterizedHostUrlSyntax(
    base.slice(0, schemeEnd),
    canonicalAuthority,
    base,
    serviceName,
  );

  const paramNames = new Set<string>();
  validateHostParams(canonicalHostSegments, paramNames, base, serviceName);
  if (path) {
    validatePathParams(splitPathSegments(path), paramNames, base, serviceName);
  }
  return baseWithAuthority(
    base,
    `${canonicalAuthority.normalizedHost}${canonicalAuthority.portSuffix}`,
  );
}

function validateAndCanonicalizeBaseUrl(
  base: string,
  serviceName: string,
): string {
  if (base.includes("\\")) {
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": must not contain backslash`,
    );
  }

  const hasTemplateVars = hasBaseUrlVars(base);
  const rawSyntaxTarget = baseUrlRawSyntaxTarget(base);
  if (hasRawWhitespace(rawSyntaxTarget)) {
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": must not contain whitespace`,
    );
  }
  if (hasUnsafeUrlCodepoint(rawSyntaxTarget)) {
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": must not contain control characters or invalid Unicode`,
    );
  }

  let knownRawPath = rawPathFromBaseUrl(rawSyntaxTarget);
  if (
    knownRawPath === "" &&
    hasTemplateVars &&
    rawSyntaxTarget.startsWith(`${AUTH_TEMPLATE_URL_PLACEHOLDER}/`)
  ) {
    knownRawPath = rawSyntaxTarget.slice(AUTH_TEMPLATE_URL_PLACEHOLDER.length);
  }
  if (hasUnsafeFirewallPath(knownRawPath)) {
    throw new Error(
      errMsg(base, serviceName, "must not contain unsafe path segments"),
    );
  }

  // Template base URLs are validated after variable resolution at compose time.
  if (hasTemplateVars) return base;

  validateUrlSchemeDelimiter(base, serviceName, "base URL");

  // Parameterized base URLs have their own validation path.
  if (hasBaseUrlParams(base)) {
    return validateBaseUrlParams(base, serviceName);
  }

  const authority = rawAuthorityFromBaseUrl(base);
  let canonicalBase = base;
  if (authority !== null) {
    if (authority === "") {
      throw new Error(
        `Invalid base URL "${base}" in firewall "${serviceName}": not a valid URL authority`,
      );
    }
    if (authorityHasEmptyPort(authority)) {
      throw new Error(
        `Invalid base URL "${base}" in firewall "${serviceName}": not a valid URL authority`,
      );
    }
    validateNoUserinfo(authority, base, serviceName);
    validateHostPercentEncoding(authority, base, serviceName);
    validateHostHasCanonicalIpv4Syntax(authority, base, serviceName);
    validateHostHasNoUnsafeIdnaMappings(authority, base, serviceName);
    validateHostHasNoRawWildcards(
      rawHostFromAuthority(authority),
      base,
      serviceName,
    );
    canonicalBase = baseWithAuthority(
      base,
      canonicalizeAuthorityForExecution(authority, base, serviceName),
    );
  }
  let url: URL;
  try {
    url = urlForCanonicalBaseSyntax(canonicalBase);
  } catch {
    if (!base.includes("://")) {
      throw new Error(
        `Invalid base URL "${base}" in firewall "${serviceName}": URL must include a scheme (e.g. "https://${base}")`,
      );
    }
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": not a valid URL`,
    );
  }
  validateBaseUrlScheme(url.protocol.slice(0, -1), base, serviceName);
  if (url.search) {
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": must not contain query string`,
    );
  }
  if (url.hash) {
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": must not contain fragment`,
    );
  }
  const canonicalAuthority = rawAuthorityFromBaseUrl(canonicalBase);
  const canonicalHostname =
    canonicalAuthority === null
      ? url.hostname
      : rawHostFromAuthority(canonicalAuthority);
  validateStaticHostLabels(canonicalHostname, base, serviceName);
  if (canonicalHostname.includes("{") || canonicalHostname.includes("}")) {
    throw new Error(
      `Invalid base URL "${base}" in firewall "${serviceName}": host must not contain braces`,
    );
  }
  return canonicalBase;
}

export function validateBaseUrl(base: string, serviceName: string): void {
  validateAndCanonicalizeBaseUrl(base, serviceName);
}

export function canonicalizeFirewallBaseUrl(
  base: string,
  serviceName: string,
): string {
  return validateAndCanonicalizeBaseUrl(base, serviceName);
}

interface AuthBaseStaticValidationTarget {
  readonly url: string | null;
  readonly dynamicPrefixSuffix: string;
}

function authBaseForStaticUrlValidation(
  authBase: string,
): AuthBaseStaticValidationTarget {
  if (!authBase.includes(AUTH_TEMPLATE_START)) {
    return { url: authBase, dynamicPrefixSuffix: "" };
  }

  const replaced = authBase.replace(
    AUTH_REFERENCE_PATTERN_G,
    AUTH_TEMPLATE_URL_PLACEHOLDER,
  );
  if (replaced.includes(AUTH_TEMPLATE_START)) {
    return { url: authBase, dynamicPrefixSuffix: "" };
  }
  const prefixMatch = AUTH_REFERENCE_PREFIX_PATTERN.exec(authBase);
  if (prefixMatch) {
    return {
      url: null,
      dynamicPrefixSuffix: authBase
        .slice(prefixMatch[0].length)
        .replace(AUTH_REFERENCE_PATTERN_G, AUTH_TEMPLATE_URL_PLACEHOLDER),
    };
  }
  return { url: replaced, dynamicPrefixSuffix: "" };
}

function validateDynamicAuthBaseSuffix(
  authBase: string,
  suffix: string,
  serviceName: string,
): void {
  if (suffix.includes(AUTH_TEMPLATE_START)) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": contains unsupported template reference`,
    );
  }
  if (hasRawWhitespace(suffix)) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": must not contain whitespace`,
    );
  }
  if (hasUnsafeUrlCodepoint(suffix)) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": must not contain control characters or invalid Unicode`,
    );
  }
  if (suffix.includes("#")) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": must not contain fragment`,
    );
  }
  if (suffix !== "" && !suffix.startsWith("/") && !suffix.startsWith("?")) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": dynamic URL suffix must start with "/" or "?"`,
    );
  }
}

export function validateAuthBaseUrl(
  authBase: string,
  serviceName: string,
): void {
  if (authBase.includes("\\")) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": must not contain backslash`,
    );
  }

  // Auth base URLs may be fully or partially secret/var-backed; resolved
  // values are only available in the sandbox when auth is applied.
  const target = authBaseForStaticUrlValidation(authBase);
  validateDynamicAuthBaseSuffix(
    authBase,
    target.dynamicPrefixSuffix,
    serviceName,
  );
  const validationUrl = target.url;
  if (validationUrl === null) return;
  if (validationUrl.includes(AUTH_TEMPLATE_START)) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": contains unsupported template reference`,
    );
  }

  if (hasRawWhitespace(validationUrl)) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": must not contain whitespace`,
    );
  }
  if (hasUnsafeUrlCodepoint(validationUrl)) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": must not contain control characters or invalid Unicode`,
    );
  }

  validateUrlSchemeDelimiter(
    validationUrl,
    serviceName,
    "auth.base URL",
    authBase,
  );

  const authority = rawAuthorityFromBaseUrl(validationUrl);
  let canonicalValidationUrl = validationUrl;
  if (authority !== null) {
    if (authority === "") {
      throw new Error(
        `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": not a valid URL authority`,
      );
    }
    if (authorityHasEmptyPort(authority)) {
      throw new Error(
        `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": not a valid URL authority`,
      );
    }
    if (authority.includes("@")) {
      throw new Error(
        `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": must not contain userinfo`,
      );
    }
    validateHostPercentEncoding(authority, validationUrl, serviceName);
    validateHostHasCanonicalIpv4Syntax(authority, validationUrl, serviceName);
    validateHostHasNoUnsafeIdnaMappings(authority, validationUrl, serviceName);
    validateHostHasNoRawWildcards(
      rawHostFromAuthority(authority),
      validationUrl,
      serviceName,
    );
    canonicalValidationUrl = baseWithAuthority(
      validationUrl,
      canonicalizeAuthorityForExecution(authority, validationUrl, serviceName),
    );
  }

  let url: URL;
  try {
    url = urlForCanonicalBaseSyntax(canonicalValidationUrl);
  } catch {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": not a valid URL`,
    );
  }
  if (
    url.protocol.slice(0, -1).toLowerCase() !== REQUIRED_AUTH_BASE_URL_SCHEME
  ) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": scheme must be https`,
    );
  }
  if (url.hash) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": must not contain fragment`,
    );
  }
  const canonicalAuthority = rawAuthorityFromBaseUrl(canonicalValidationUrl);
  validateStaticHostLabels(
    canonicalAuthority === null
      ? url.hostname
      : rawHostFromAuthority(canonicalAuthority),
    validationUrl,
    serviceName,
  );

  const rawAuthAuthority = rawAuthorityFromBaseUrl(authBase);
  if (
    rawAuthAuthority !== null &&
    rawAuthAuthority.includes(AUTH_TEMPLATE_START) &&
    (!isAscii(rawAuthAuthority) || rawAuthAuthority.includes("%"))
  ) {
    throw new Error(
      `Invalid auth.base URL "${authBase}" in firewall "${serviceName}": dynamic authority must use ASCII static text`,
    );
  }
}

/**
 * Expanded firewall config stored in compose content.
 * Resolved from firewall name + FirewallConfig at compose time, then frozen.
 *
 * - `name`: firewall config name (e.g., "slack"). Also the key used in
 *   compose content to reference this firewall config, and the map key in
 *   `FirewallPolicies` / `NetworkPolicies`.
 * - `description`: optional description from the firewall config
 */
export interface ExpandedFirewallConfig {
  name: string;
  description?: string;
  apis: FirewallApi[];
  placeholders?: Record<string, string>;
  /**
   * Optional per-firewall default permission overrides for auto-generated
   * model-provider firewalls (which otherwise default to fully permissive).
   * Permission names listed in `deny`/`ask` are routed accordingly; all
   * others remain allowed. `unknownPolicy` controls handling of base-URL
   * matches that don't match any permission rule. Ignored on the connector
   * firewall path (which uses stored per-user policies instead).
   */
  defaultPolicies?: {
    deny?: string[];
    ask?: string[];
    unknownPolicy?: FirewallPolicyValue;
  };
}
