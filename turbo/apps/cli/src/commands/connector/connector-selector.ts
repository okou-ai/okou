import { uuid as zUuid } from "zod";

export type ConnectorSelectorIdentity =
  | { readonly kind: "builtin"; readonly slug: string; readonly label: string }
  | {
      readonly kind: "custom";
      readonly id: string;
      readonly slug: string;
      readonly label: string;
    };

export function parseConnectorSelector(selector: string): {
  readonly kind: "builtin" | "custom" | undefined;
  readonly value: string;
} {
  const kind = selector.startsWith("builtin:")
    ? "builtin"
    : selector.startsWith("custom:")
      ? "custom"
      : undefined;
  const value = kind ? selector.slice(kind.length + 1) : selector;
  if (!value.trim()) {
    throw new Error("Connector selector cannot be empty");
  }
  return { kind, value };
}

function explicitConnectorSelector(
  identity: ConnectorSelectorIdentity,
): string {
  return identity.kind === "custom"
    ? `custom:${identity.id}`
    : `builtin:${identity.slug}`;
}

export function findConnectorBySelector<T>(
  connectors: readonly T[],
  selector: string,
  identityOf: (connector: T) => ConnectorSelectorIdentity,
): T | undefined {
  const { kind, value } = parseConnectorSelector(selector);
  const uuid = zUuid().safeParse(value);
  const canonical = uuid.success ? uuid.data.toLowerCase() : value;
  const candidates = connectors
    .map((connector) => {
      return { connector, identity: identityOf(connector) };
    })
    .filter(({ identity }) => {
      return kind === undefined || identity.kind === kind;
    });
  const exact = candidates.filter(({ identity }) => {
    return (
      identity.slug === canonical ||
      (identity.kind === "custom" && identity.id.toLowerCase() === canonical)
    );
  });
  const slugs = exact.length
    ? exact
    : candidates.filter(({ identity }) => {
        return identity.slug.toLowerCase() === value.toLowerCase();
      });
  const matches = slugs.length
    ? slugs
    : candidates.filter(({ identity }) => {
        return identity.label === value;
      });
  if (matches.length > 1) {
    const selectors = matches
      .map(({ identity }) => {
        return explicitConnectorSelector(identity);
      })
      .sort();
    throw new Error(
      `Ambiguous connector selector: ${selector}\nCandidates: ${selectors.join(", ")}\nUse an explicit connector selector.`,
    );
  }
  return matches[0]?.connector;
}
