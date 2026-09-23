import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  FirewallBaseUrlResolutionError,
  hasUnsafeFirewallPath,
  resolveFirewallBaseUrlTemplate,
  type FirewallBaseHostPolicy,
} from "@okouai/connectors/firewall-types";

import { safeSync, safeUrlParse } from "../utils";
import type {
  ConnectorServerFirewallCatalog,
  ConnectorServerFirewallExecutionMetadata,
  FirewallRoutingRouteMetadata,
} from "./connector-server-firewall-catalog.service";

const BASE_URL_VAR_PATTERN = /\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

interface ConnectorDiagnosticExecutionTemplate {
  readonly credentialed: boolean;
  readonly hostPolicy?: FirewallBaseHostPolicy;
}

export interface ConnectorDiagnosticCatalogApi {
  readonly base: string;
  readonly usesAwsSigv4: boolean;
  readonly routes: readonly FirewallRoutingRouteMetadata[];
  readonly environmentNames: readonly string[];
}

export interface ConnectorDiagnosticCatalogView {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly baseUrlVarNames: readonly string[];
  readonly apis: readonly ConnectorDiagnosticCatalogApi[];
  readonly executionMetadata: ConnectorServerFirewallExecutionMetadata;
}

export interface ConnectorDiagnosticBaseCandidate {
  readonly sourceBase: string;
  readonly decisionBase: string;
  readonly displayBase: string;
  readonly usesAwsSigv4: boolean;
  readonly routes: readonly FirewallRoutingRouteMetadata[];
  readonly environmentNames: readonly string[] | null;
}

export interface ParsedConnectorDiagnosticRequest {
  readonly method: string;
  readonly url: string;
}

interface ConnectorDiagnosticUnsafeInput {
  readonly outcome: "unsafe-input";
  readonly reason: "invalid-method" | "invalid-url" | "unsafe-path";
}

function isValidMethod(method: string): boolean {
  return (
    method === "GET" ||
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE" ||
    method === "HEAD" ||
    method === "OPTIONS"
  );
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function baseKey(value: string): string {
  return stripTrailingSlash(value);
}

function connectorDiagnosticBaseUrlVarNames(base: string): readonly string[] {
  return [
    ...new Set(
      [...base.matchAll(BASE_URL_VAR_PATTERN)].map((match) => {
        return match[1]!;
      }),
    ),
  ];
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...new Set(left)].sort();
  const rightSorted = [...new Set(right)].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((name, index) => {
      return name === rightSorted[index];
    })
  );
}

function executionTemplatesByBase(
  metadata: ConnectorServerFirewallExecutionMetadata,
): ReadonlyMap<string, ConnectorDiagnosticExecutionTemplate> {
  const templates = new Map<string, ConnectorDiagnosticExecutionTemplate>();
  for (const template of metadata.baseUrlTemplates) {
    const key = baseKey(template.base);
    if (templates.has(key)) {
      throw new Error(
        `Duplicate firewall execution base template for ${metadata.connectorSlug}`,
      );
    }
    templates.set(key, {
      credentialed: template.credentialed,
      ...(template.hostPolicy === undefined
        ? {}
        : { hostPolicy: template.hostPolicy }),
    });
  }
  return templates;
}

export async function loadConnectorDiagnosticCatalogView(
  catalog: ConnectorServerFirewallCatalog,
  connectorSlug: string,
): Promise<ConnectorDiagnosticCatalogView | null> {
  const routing = await catalog.loadRoutingMetadata(connectorSlug);
  if (!routing) {
    return null;
  }

  const execution = catalog.getExecutionMetadata(routing.connectorSlug);
  if (!execution || execution.connectorSlug !== routing.connectorSlug) {
    throw new Error(
      `Missing firewall execution metadata for ${routing.connectorSlug}`,
    );
  }

  const executionTemplates = executionTemplatesByBase(execution);
  const routingBaseUrlVarNames = new Set<string>();
  const dynamicBaseKeys = new Set<string>();
  const apis: ConnectorDiagnosticCatalogApi[] = [];

  for (const api of routing.apis) {
    const names = connectorDiagnosticBaseUrlVarNames(api.base);
    for (const name of names) {
      routingBaseUrlVarNames.add(name);
    }
    const key = baseKey(api.base);
    const executionTemplate =
      names.length === 0 ? null : (executionTemplates.get(key) ?? null);
    if (names.length > 0 && !executionTemplate) {
      throw new Error(
        `Missing firewall execution base template for ${routing.connectorSlug}`,
      );
    }
    if (executionTemplate) {
      dynamicBaseKeys.add(key);
    }
    apis.push({
      base: api.base,
      usesAwsSigv4: api.usesAwsSigv4,
      routes: api.routes,
      environmentNames: api.environmentNames,
    });
  }

  if (
    !sameNames([...routingBaseUrlVarNames], execution.baseUrlVarNames) ||
    executionTemplates.size !== dynamicBaseKeys.size
  ) {
    throw new Error(
      `Mismatched firewall base metadata for ${routing.connectorSlug}`,
    );
  }

  return {
    connectorSlug: routing.connectorSlug,
    label: routing.label,
    baseUrlVarNames: [...routingBaseUrlVarNames].sort(),
    apis,
    executionMetadata: execution,
  };
}

function rawAuthorityFromUrl(url: string): string | null {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) {
    return null;
  }

  const authorityStart = schemeEnd + 3;
  let authorityEnd = url.length;
  for (const delimiter of ["/", "?", "#"]) {
    const index = url.indexOf(delimiter, authorityStart);
    if (index !== -1) {
      authorityEnd = Math.min(authorityEnd, index);
    }
  }
  return url.slice(authorityStart, authorityEnd);
}

function rawAuthorityHasUnsafeSyntax(url: string): boolean {
  const authority = rawAuthorityFromUrl(url);
  if (authority === null) {
    return false;
  }
  return (
    authority === "" ||
    authority.includes("\\") ||
    authority.includes("%") ||
    [...authority].some((character) => {
      return character.charCodeAt(0) > 0x7f;
    })
  );
}

function stripQueryAndFragment(url: string): string {
  const queryIndex = url.indexOf("?");
  const fragmentIndex = url.indexOf("#");
  let end = url.length;
  if (queryIndex !== -1) {
    end = Math.min(end, queryIndex);
  }
  if (fragmentIndex !== -1) {
    end = Math.min(end, fragmentIndex);
  }
  return url.slice(0, end);
}

function rawPathFromUrl(url: string): string {
  const schemeEnd = url.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = url.indexOf("/", authorityStart);
  return pathStart === -1 ? "/" : url.slice(pathStart);
}

export function parseConnectorDiagnosticRequest(
  method: string,
  url: string,
): ParsedConnectorDiagnosticRequest | ConnectorDiagnosticUnsafeInput {
  const upperMethod = method.toUpperCase();
  if (!isValidMethod(upperMethod)) {
    return { outcome: "unsafe-input", reason: "invalid-method" };
  }

  if (
    !url.includes("://") ||
    /\s/u.test(url) ||
    rawAuthorityHasUnsafeSyntax(url)
  ) {
    return { outcome: "unsafe-input", reason: "invalid-url" };
  }

  const parsed = safeUrlParse(url);
  if (
    !parsed ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return { outcome: "unsafe-input", reason: "invalid-url" };
  }

  const sanitizedUrl = stripQueryAndFragment(url);
  if (hasUnsafeFirewallPath(rawPathFromUrl(sanitizedUrl))) {
    return { outcome: "unsafe-input", reason: "unsafe-path" };
  }

  return { method: upperMethod, url: sanitizedUrl };
}

function dynamicTemplateToPattern(base: string): string | null {
  const pattern = base.replace(BASE_URL_VAR_PATTERN, (_match, name: string) => {
    return `{${name}}`;
  });
  return pattern.includes("://") ? pattern : null;
}

function executionTemplateForBase(
  metadata: ConnectorServerFirewallExecutionMetadata,
  base: string,
): ConnectorDiagnosticExecutionTemplate {
  const template = metadata.baseUrlTemplates.find((entry) => {
    return baseKey(entry.base) === baseKey(base);
  });
  if (!template) {
    throw new Error(
      `Missing firewall execution base template for ${metadata.connectorSlug}`,
    );
  }
  return {
    credentialed: template.credentialed,
    ...(template.hostPolicy === undefined
      ? {}
      : { hostPolicy: template.hostPolicy }),
  };
}

interface ConnectorDiagnosticBaseResolution {
  readonly candidate: {
    readonly sourceBase: string;
    readonly decisionBase: string;
    readonly displayBase: string;
  } | null;
  readonly unresolved: boolean;
}

export function resolveConnectorDiagnosticBase(
  executionMetadata: ConnectorServerFirewallExecutionMetadata,
  base: string,
  baseUrlVars: Readonly<Record<string, string>> | null,
  options: { readonly allowStructuralDynamic: boolean },
): ConnectorDiagnosticBaseResolution {
  const names = connectorDiagnosticBaseUrlVarNames(base);
  if (names.length === 0) {
    return {
      candidate: {
        sourceBase: base,
        decisionBase: base,
        displayBase: stripTrailingSlash(base),
      },
      unresolved: false,
    };
  }

  const executionTemplate = executionTemplateForBase(executionMetadata, base);
  if (baseUrlVars) {
    const resolution = safeSync(() => {
      return resolveFirewallBaseUrlTemplate({
        serviceName: executionMetadata.connectorSlug,
        base,
        vars: baseUrlVars,
        credentialed: executionTemplate.credentialed,
        ...(executionTemplate.hostPolicy === undefined
          ? {}
          : { hostPolicy: executionTemplate.hostPolicy }),
      });
    });
    if ("error" in resolution) {
      if (!(resolution.error instanceof FirewallBaseUrlResolutionError)) {
        throw resolution.error;
      }
      return { candidate: null, unresolved: true };
    }
    return {
      candidate: {
        sourceBase: base,
        decisionBase: resolution.ok,
        displayBase: stripTrailingSlash(resolution.ok),
      },
      unresolved: false,
    };
  }

  if (!options.allowStructuralDynamic) {
    return { candidate: null, unresolved: true };
  }
  const pattern = dynamicTemplateToPattern(base);
  if (!pattern) {
    return { candidate: null, unresolved: true };
  }
  return {
    candidate: {
      sourceBase: base,
      decisionBase: pattern,
      displayBase: stripTrailingSlash(base),
    },
    unresolved: false,
  };
}

export function buildConnectorDiagnosticBaseCandidates(
  view: ConnectorDiagnosticCatalogView,
  baseUrlVars: Readonly<Record<string, string>> | null,
  options: { readonly allowStructuralDynamic: boolean } = {
    allowStructuralDynamic: true,
  },
): {
  readonly candidates: readonly ConnectorDiagnosticBaseCandidate[];
  readonly hasUnresolvedDynamicBase: boolean;
} {
  const candidates: ConnectorDiagnosticBaseCandidate[] = [];
  let hasUnresolvedDynamicBase = false;
  const sourceBaseByDecisionBase = new Map<string, string>();

  for (const api of view.apis) {
    const resolution = resolveConnectorDiagnosticBase(
      view.executionMetadata,
      api.base,
      baseUrlVars,
      options,
    );
    hasUnresolvedDynamicBase ||= resolution.unresolved;
    if (!resolution.candidate) {
      continue;
    }
    const decisionKey = baseKey(resolution.candidate.decisionBase);
    const existingSourceBase = sourceBaseByDecisionBase.get(decisionKey);
    if (
      existingSourceBase !== undefined &&
      baseKey(existingSourceBase) !== baseKey(api.base)
    ) {
      throw new Error(
        `Conflicting resolved firewall bases for ${view.connectorSlug}`,
      );
    }
    sourceBaseByDecisionBase.set(decisionKey, api.base);
    candidates.push({
      ...resolution.candidate,
      usesAwsSigv4: api.usesAwsSigv4,
      routes: api.routes,
      environmentNames: api.environmentNames,
    });
  }

  return { candidates, hasUnresolvedDynamicBase };
}

export function publicConnectorDiagnosticBase(base: string): string {
  const publicNameByPrivateName = new Map<string, string>();
  return base.replace(BASE_URL_VAR_PATTERN, (_match, name: string) => {
    let publicName = publicNameByPrivateName.get(name);
    if (!publicName) {
      publicName = `parameter${publicNameByPrivateName.size + 1}`;
      publicNameByPrivateName.set(name, publicName);
    }
    return `{${publicName}}`;
  });
}
