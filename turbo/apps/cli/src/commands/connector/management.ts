import { z } from "zod";
import {
  connectorAccountDisplayNameSchema,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  listConnectorCatalog,
  listCustomConnectors,
} from "../../lib/api/domains/connectors";
import { connectorDiscoveryItems } from "./discovery";
import { findConnectorBySelector } from "./connector-selector";

export function parseConnectionId(value: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success)
    throw new InvalidArgumentError(
      "Use a valid connection UUID returned for this connector.",
    );
  return parsed.data.toLowerCase();
}

export function parseAccountName(value: string): string {
  const parsed = connectorAccountDisplayNameSchema.safeParse(value);
  if (!parsed.success)
    throw new InvalidArgumentError(
      "Account name must be between 1 and 255 characters.",
    );
  return parsed.data;
}

export interface AccountMutationOptions {
  readonly add?: boolean;
  readonly reconnect?: string;
  readonly accountName?: string;
}

export function addAccountMutationOptions(command: Command): Command {
  return command
    .addOption(
      new Option("--add", "Create a new member account").conflicts("reconnect"),
    )
    .addOption(
      new Option(
        "--reconnect <connection-id>",
        "Reconnect this exact member account",
      )
        .conflicts("add")
        .argParser(parseConnectionId),
    )
    .addOption(
      new Option(
        "--account-name <name>",
        "Name the new account (requires --add)",
      )
        .conflicts("reconnect")
        .argParser(parseAccountName),
    );
}

export function accountMutation(options: AccountMutationOptions) {
  if (options.accountName !== undefined && !options.add)
    throw new Error("--account-name requires --add");
  if (options.add)
    return {
      intent: "add" as const,
      ...(options.accountName === undefined
        ? {}
        : { displayName: options.accountName }),
    };
  if (options.reconnect)
    return { intent: "reconnect" as const, connectionId: options.reconnect };
  throw new Error(
    "Specify --add or --reconnect <connection-id> to select the account operation.",
  );
}

export async function resolveManagementConnector(selector: string) {
  const [{ connectors }, custom] = await Promise.all([
    listConnectorCatalog(),
    listCustomConnectors(),
  ]);
  const connector = findConnectorBySelector(
    connectorDiscoveryItems(connectors, custom),
    selector,
    (item) => {
      return item.kind === "custom"
        ? {
            kind: "custom",
            id: item.customConnector.id,
            slug: item.slug,
            label: item.label,
          }
        : { kind: "builtin", slug: item.slug, label: item.label };
    },
  );
  if (!connector)
    throw new Error(`Unknown or unavailable connector: ${selector}`);
  const target: ConnectorAccountTarget =
    connector.kind === "catalog"
      ? { kind: "builtin", connectorSlug: connector.slug }
      : { kind: "custom", customConnectorId: connector.customConnector.id };
  return { connector, target };
}

function nonsecretConnectorUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    const secretQuery = [...url.searchParams.keys()].some((key) => {
      return /^(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|token|client[_-]?(id|secret)|password|secret)$/iu.test(
        key,
      );
    });
    return secretQuery ? null : value;
  } catch {
    return null;
  }
}

/** Only member/definition metadata, never OAuth app configuration or injection values. */
export function customConnectorMetadata(connector: CustomConnectorResponse) {
  return {
    id: connector.id,
    slug: connector.slug,
    kind: connector.kind,
    displayName: connector.displayName,
    authMode: connector.authMode,
    ...(connector.kind === "mcp"
      ? {
          endpoint: nonsecretConnectorUrl(connector.endpoint),
          transport: connector.transport,
        }
      : {}),
    urlPrefixTemplates: connector.prefixTemplates
      .map(nonsecretConnectorUrl)
      .filter((value): value is string => {
        return value !== null;
      }),
    permissionBundleRef: connector.permissionBundleRef ?? null,
    ...(isIntegrationManagedCustomConnector(connector)
      ? {
          connected: connector.connected,
          connectedAccountId: connector.connectedAccountId ?? null,
          configuredFieldKeys: connector.configuredFieldKeys,
          missingRequiredFields: connector.missingRequiredFields,
        }
      : {}),
    fields: connector.fields.map((field) => {
      return {
        key: field.key,
        kind: field.kind,
        required: field.required,
      };
    }),
    storageVersion: connector.storageVersion,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
  };
}
