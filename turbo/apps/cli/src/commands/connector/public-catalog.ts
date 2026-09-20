import type { PublicConnectorCatalogAuthMethodDetail } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorCatalogStatus } from "../../lib/api/domains/connectors";
import { findConnectorBySelector } from "./connector-selector";

export type PublicConnectorStatus = ConnectorCatalogStatus;

interface ConnectorDiscoverySearchItem {
  readonly slug: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly generation: readonly string[];
  readonly authMethods: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string | null;
  }[];
}

interface ConnectorSearchResult<T extends ConnectorDiscoverySearchItem> {
  readonly connector: T;
  readonly score: number;
  readonly matchedField: string;
}

interface ConnectorSearchOutput<T extends ConnectorDiscoverySearchItem> {
  readonly results: readonly ConnectorSearchResult<T>[];
  readonly total: number;
}

const TOKEN_BOUNDARY = /[_\-\s]+/;
const CASE_BOUNDARY = /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
const MIN_SCORE = 10;

function tokenize(input: string): Set<string> {
  const tokens = new Set<string>();
  for (const chunk of input.split(TOKEN_BOUNDARY)) {
    if (!chunk) continue;
    for (const sub of chunk.split(CASE_BOUNDARY)) {
      const lower = sub.toLowerCase();
      if (lower) tokens.add(lower);
    }
  }
  return tokens;
}

function publicStrings(connector: ConnectorDiscoverySearchItem): string[] {
  return [
    connector.slug,
    connector.label,
    connector.description,
    connector.category,
    ...connector.tags,
    ...connector.generation,
    ...connector.authMethods.flatMap((authMethod) => {
      return [
        authMethod.id,
        authMethod.label,
        ...(authMethod.description ? [authMethod.description] : []),
      ];
    }),
  ];
}

type ScoreHit = { score: number; matchedField: string };

function best(candidates: readonly (ScoreHit | null)[]): ScoreHit | null {
  return candidates.reduce<ScoreHit | null>((bestHit, hit) => {
    if (!hit) return bestHit;
    if (!bestHit || hit.score > bestHit.score) return hit;
    return bestHit;
  }, null);
}

function scoreExact(
  keywordLower: string,
  skipPrivateIdentifierMatches: boolean,
  connector: ConnectorDiscoverySearchItem,
): ScoreHit | null {
  if (connector.slug.toLowerCase() === keywordLower) {
    return { score: 100, matchedField: "slug" };
  }
  if (connector.label.toLowerCase() === keywordLower) {
    return { score: 80, matchedField: "label" };
  }
  for (const tag of connector.tags) {
    if (skipPrivateIdentifierMatches && tag.includes("_")) continue;
    if (tag.toLowerCase() === keywordLower) {
      return { score: 70, matchedField: `tag:${tag}` };
    }
  }
  for (const generationType of connector.generation) {
    if (generationType.toLowerCase() === keywordLower) {
      return { score: 65, matchedField: `generation:${generationType}` };
    }
  }
  for (const authMethod of connector.authMethods) {
    if (authMethod.id.toLowerCase() === keywordLower) {
      return { score: 60, matchedField: `auth-method:${authMethod.id}` };
    }
    if (authMethod.label.toLowerCase() === keywordLower) {
      return { score: 60, matchedField: `auth-method:${authMethod.label}` };
    }
  }
  if (connector.category.toLowerCase() === keywordLower) {
    return { score: 55, matchedField: "category" };
  }
  return null;
}

function scoreSubstring(
  keywordLower: string,
  skipPrivateIdentifierMatches: boolean,
  connector: ConnectorDiscoverySearchItem,
): ScoreHit | null {
  const candidates: ScoreHit[] = [];
  if (connector.slug.toLowerCase().includes(keywordLower)) {
    candidates.push({ score: 50, matchedField: "slug" });
  }
  if (connector.label.toLowerCase().includes(keywordLower)) {
    candidates.push({ score: 50, matchedField: "label" });
  }
  for (const tag of connector.tags) {
    if (skipPrivateIdentifierMatches && tag.includes("_")) continue;
    if (tag.toLowerCase().includes(keywordLower)) {
      candidates.push({ score: 25, matchedField: `tag:${tag}` });
    }
  }
  for (const generationType of connector.generation) {
    if (generationType.toLowerCase().includes(keywordLower)) {
      candidates.push({
        score: 25,
        matchedField: `generation:${generationType}`,
      });
    }
  }
  for (const authMethod of connector.authMethods) {
    if (
      authMethod.id.toLowerCase().includes(keywordLower) ||
      authMethod.label.toLowerCase().includes(keywordLower)
    ) {
      candidates.push({
        score: 20,
        matchedField: `auth-method:${authMethod.id}`,
      });
    }
  }
  if (connector.category.toLowerCase().includes(keywordLower)) {
    candidates.push({ score: 20, matchedField: "category" });
  }
  if (connector.description.toLowerCase().includes(keywordLower)) {
    candidates.push({ score: 15, matchedField: "description" });
  }

  return best(candidates);
}

function scoreTokens(
  keywordTokens: ReadonlySet<string>,
  connector: ConnectorDiscoverySearchItem,
): ScoreHit | null {
  const candidateTokens = new Set<string>();
  for (const source of publicStrings(connector)) {
    for (const token of tokenize(source)) {
      candidateTokens.add(token);
    }
  }

  let intersection = 0;
  let firstCommon = "";
  for (const token of keywordTokens) {
    if (candidateTokens.has(token)) {
      intersection++;
      if (!firstCommon) firstCommon = token;
    }
  }
  if (intersection === 0) return null;
  return { score: 10 * intersection, matchedField: `token:${firstCommon}` };
}

function scoreConnector(
  keywordLower: string,
  keyword: string,
  keywordTokens: ReadonlySet<string>,
  connector: ConnectorDiscoverySearchItem,
): ScoreHit | null {
  const skipPrivateIdentifierMatches =
    /^[A-Za-z0-9_]+$/.test(keyword) && keyword.includes("_");
  const tokenHit = skipPrivateIdentifierMatches
    ? null
    : scoreTokens(keywordTokens, connector);
  const hit = best([
    scoreExact(keywordLower, skipPrivateIdentifierMatches, connector),
    scoreSubstring(keywordLower, skipPrivateIdentifierMatches, connector),
    tokenHit,
  ]);
  if (!hit || hit.score < MIN_SCORE) return null;
  return hit;
}

export function searchConnectorCatalog<T extends ConnectorDiscoverySearchItem>(
  connectors: readonly T[],
  keyword: string,
  limit: number,
): ConnectorSearchOutput<T> {
  const trimmed = keyword.trim();
  if (!trimmed) return { results: [], total: 0 };

  const keywordLower = trimmed.toLowerCase();
  const keywordTokens = tokenize(trimmed);
  const hits = connectors.flatMap((connector): ConnectorSearchResult<T>[] => {
    const hit = scoreConnector(keywordLower, trimmed, keywordTokens, connector);
    if (!hit) return [];
    return [
      {
        connector,
        score: hit.score,
        matchedField: hit.matchedField,
      },
    ];
  });

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.connector.slug.localeCompare(b.connector.slug);
  });

  return {
    results: hits.slice(0, limit),
    total: hits.length,
  };
}

export function findConnectorStatusItem(
  connectors: readonly PublicConnectorStatus[],
  connectorSlug: string,
): PublicConnectorStatus | null {
  return (
    findConnectorBySelector(connectors, connectorSlug, (connector) => {
      return { kind: "builtin", slug: connector.slug, label: connector.label };
    }) ?? null
  );
}

export function availableConnectorSlugs(
  connectors: readonly PublicConnectorStatus[],
): string {
  return connectors
    .map((connector) => {
      return connector.slug;
    })
    .join(", ");
}

export function resolveManualGrantAuthMethod(
  connector: PublicConnectorStatus,
  rawAuthMethod: string | undefined,
): PublicConnectorCatalogAuthMethodDetail {
  if (rawAuthMethod) {
    const authMethod = connector.authMethods.find((method) => {
      return method.id === rawAuthMethod;
    });
    if (!authMethod) {
      throw new Error(
        `${connector.slug} connector does not have ${rawAuthMethod} auth method`,
        {
          cause: new Error(
            `Available auth methods: ${connector.authMethods
              .map((method) => {
                return method.id;
              })
              .join(", ")}`,
          ),
        },
      );
    }

    if (authMethod.grantKind === "manual") {
      return authMethod;
    }

    throw new Error(
      `${connector.slug} ${authMethod.id} auth method does not use a manual grant`,
    );
  }

  const manualAuthMethods = connector.authMethods.filter((method) => {
    return method.grantKind === "manual";
  });
  const authMethod = manualAuthMethods[0];
  if (manualAuthMethods.length === 1 && authMethod) {
    return authMethod;
  }
  if (manualAuthMethods.length === 0) {
    throw new Error(`${connector.slug} connector does not use a manual grant`);
  }

  throw new Error(
    `${connector.slug} connector has multiple manual grant auth methods`,
    {
      cause: new Error(
        `Pass --auth-method ${manualAuthMethods
          .map((method) => {
            return method.id;
          })
          .join("|")}`,
      ),
    },
  );
}
