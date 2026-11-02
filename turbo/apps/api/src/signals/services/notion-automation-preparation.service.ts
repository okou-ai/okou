import { accept, HttpStatusError } from "@okouai/connectors/accept";
import {
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
  type NotionChildPageCreatedEventConfig,
  type NotionChildPageCreatedEventCreateConfig,
  type NotionDatabaseItemCreatedEventConfig,
  type NotionDatabaseItemCreatedEventCreateConfig,
  type NotionDataSourceReference,
  type NotionPageContentUpdatedEventConfig,
  type NotionPageContentUpdatedEventCreateConfig,
  type NotionPageReference,
} from "@okouai/api-contracts/contracts/workflows";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { command } from "ccstate";
import {
  array,
  boolean,
  iso,
  literal,
  object,
  record,
  string,
  union,
  uuid,
  unknown as zUnknown,
  url as zUrl,
  type infer as zInfer,
  type ZodType,
} from "zod";

import { nowDate } from "../../lib/time";
import { settle, safeJsonParse, safeUrlParse, tapError } from "../utils";
import {
  loadBuiltinConnectorCredentialConnection$,
  loadBuiltinConnectorCredentialValues$,
  refreshBuiltinConnectorCredentialAccess$,
  builtinConnectorCredentialRuntimeValueRef,
} from "./builtin-connector-credential-runtime.service";
import { readConnectorRuntimeAuthSelection$ } from "./connector-catalog-slug-source.service";

const NOTION_ACCESS_TOKEN_ENVIRONMENT_NAME = "NOTION_TOKEN";

const NOTION_API_BASE = "https://api.notion.com/v1";

const NOTION_VERSION = "2026-03-11";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const notionPageParentSchema = union([
  object({ type: literal("page_id"), page_id: uuid() }),
  object({
    type: literal("data_source_id"),
    data_source_id: uuid(),
    database_id: uuid().optional(),
  }),
  object({ type: literal("database_id"), database_id: uuid() }),
  object({ type: literal("block_id"), block_id: uuid() }),
  object({ type: literal("workspace") }).passthrough(),
]);

const notionPageResponseSchema = object({
  object: literal("page"),
  id: uuid(),
  created_time: iso.datetime().optional(),
  last_edited_time: iso.datetime().optional(),
  archived: boolean().optional(),
  in_trash: boolean().optional(),
  url: zUrl().optional(),
  parent: notionPageParentSchema,
  properties: record(string(), zUnknown()).optional(),
}).passthrough();

const notionDataSourceResponseSchema = object({
  object: literal("data_source"),
  id: uuid(),
  name: string().nullable().optional(),
  url: zUrl().optional(),
  parent: object({
    type: literal("database_id"),
    database_id: uuid(),
  }).passthrough(),
}).passthrough();

const notionDatabaseResponseSchema = object({
  object: literal("database"),
  id: uuid(),
  url: zUrl().optional(),
  title: array(
    object({
      plain_text: string().optional(),
    }).passthrough(),
  ).default([]),
  data_sources: array(
    object({
      id: uuid(),
      name: string().nullable().optional(),
    }).passthrough(),
  ).default([]),
}).passthrough();

export type NotionPageResponse = zInfer<typeof notionPageResponseSchema>;

type NotionDataSourceResponse = zInfer<typeof notionDataSourceResponseSchema>;

type NotionDatabaseResponse = zInfer<typeof notionDatabaseResponseSchema>;

interface NotionAccess {
  readonly connectorId: string;
  readonly accessToken: string;
}

type NotionAccessResult =
  | { readonly kind: "ok"; readonly access: NotionAccess }
  | { readonly kind: "bad_request"; readonly message: string };

type NotionFetchResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "unauthorized" }
  | {
      readonly kind: "transient_error";
      readonly status: number | null;
      readonly message: string;
    };

export type NotionAutomationEventType =
  | "notion-child-page-created"
  | "notion-database-item-created"
  | "notion-page-content-updated";

function tokenNeedsRefresh(tokenExpiresAt: Date | null, currentTime: Date) {
  if (tokenExpiresAt === null) {
    return true;
  }
  return (
    tokenExpiresAt.getTime() <= currentTime.getTime() + TOKEN_REFRESH_BUFFER_MS
  );
}

export function normalizeNotionUuid(value: string): string | null {
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    return null;
  }
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

function parseStandardNotionUrlId(value: string): string | null {
  const url = safeUrlParse(value.trim());
  if (!url) {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  if (url.hostname !== "notion.so" && url.hostname !== "www.notion.so") {
    return null;
  }

  const path = url.pathname.replace(/\/+$/, "");
  const match = path.match(
    /([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  );
  return match ? normalizeNotionUuid(match[1]!) : null;
}

function parseStandardNotionPageUrl(value: string): string | null {
  return parseStandardNotionUrlId(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function notionTitleFromProperties(
  properties: Record<string, unknown> | undefined,
): string | null {
  for (const property of Object.values(properties ?? {})) {
    if (!isRecord(property) || property.type !== "title") {
      continue;
    }
    const titleItems = property.title;
    if (!Array.isArray(titleItems)) {
      continue;
    }
    const title = titleItems
      .flatMap((item) => {
        if (!isRecord(item)) {
          return [];
        }
        const plainText = item.plain_text;
        return typeof plainText === "string" ? [plainText] : [];
      })
      .join("")
      .trim();
    if (title.length > 0) {
      return title;
    }
  }
  return null;
}

export function notionPageReference(
  page: NotionPageResponse,
  rawUrl?: string,
): NotionPageReference {
  return {
    id: page.id,
    url: page.url ?? rawUrl ?? `https://www.notion.so/${page.id}`,
    title: notionTitleFromProperties(page.properties),
    ...(rawUrl ? { rawUrl } : {}),
  };
}

function notionDatabaseTitle(database: NotionDatabaseResponse): string | null {
  const title = database.title
    .map((item) => {
      return item.plain_text ?? "";
    })
    .join("")
    .trim();
  return title.length > 0 ? title : null;
}

export function notionDataSourceReference(args: {
  readonly dataSource: NotionDataSourceResponse;
  readonly title: string | null;
  readonly rawUrl?: string;
}): NotionDataSourceReference {
  return {
    id: args.dataSource.id,
    url:
      args.dataSource.url ??
      args.rawUrl ??
      `https://www.notion.so/${args.dataSource.id}`,
    title: args.title,
    ...(args.rawUrl ? { rawUrl: args.rawUrl } : {}),
  };
}

export function pageIsUsable(page: NotionPageResponse): boolean {
  return page.archived !== true && page.in_trash !== true;
}

export const resolveNotionCredentialAccess$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
    },
    signal: AbortSignal,
  ): Promise<NotionAccessResult> => {
    const currentTime = nowDate();
    const snapshot = await set(
      readConnectorRuntimeAuthSelection$,
      {
        connectorSlugs: ["notion"],
      },
      signal,
    );
    signal.throwIfAborted();
    const loaded = await set(loadBuiltinConnectorCredentialConnection$, {
      snapshot,
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: "notion",
      connectorId: args.connectorId,
    });
    signal.throwIfAborted();
    if (loaded.kind === "missing") {
      return {
        kind: "bad_request",
        message: "Connect Notion before adding a Notion event automation",
      };
    }
    if (loaded.kind === "unavailable" || loaded.connection.needsReconnect) {
      return {
        kind: "bad_request",
        message: "Reconnect Notion before using Notion event automations",
      };
    }
    const connection = loaded.connection;
    const accessTokenValueRef = builtinConnectorCredentialRuntimeValueRef(
      connection,
      NOTION_ACCESS_TOKEN_ENVIRONMENT_NAME,
    );
    if (accessTokenValueRef === null) {
      return {
        kind: "bad_request",
        message: "Reconnect Notion before using Notion event automations",
      };
    }
    const values = await set(
      loadBuiltinConnectorCredentialValues$,
      {
        connection,
        valueRefs: [accessTokenValueRef],
      },
      signal,
    );
    signal.throwIfAborted();
    const accessToken = values.get(accessTokenValueRef);
    if (!accessToken) {
      return {
        kind: "bad_request",
        message: "Reconnect Notion before using Notion event automations",
      };
    }
    if (!tokenNeedsRefresh(connection.tokenExpiresAt, currentTime)) {
      return {
        kind: "ok",
        access: {
          connectorId: connection.connectorId,
          accessToken,
        },
      };
    }
    const refreshed = await set(
      refreshBuiltinConnectorCredentialAccess$,
      {
        connection,
        orgId: args.orgId,
        userId: args.userId,
        runtimeEnvironmentName: NOTION_ACCESS_TOKEN_ENVIRONMENT_NAME,
        persist: { markNeedsReconnectOnFailure: true },
      },
      signal,
    );
    if (refreshed.kind === "configuration-unavailable") {
      return {
        kind: "bad_request",
        message: "Notion OAuth client env vars are not configured",
      };
    }
    if (refreshed.kind !== "ok") {
      return {
        kind: "bad_request",
        message: "Reconnect Notion before using Notion event automations",
      };
    }
    return {
      kind: "ok",
      access: {
        connectorId: connection.connectorId,
        accessToken: refreshed.accessToken,
      },
    };
  },
);

async function notionFetchJson<T>(
  schema: ZodType<T>,
  accessToken: string,
  url: string,
  signal: AbortSignal,
): Promise<NotionFetchResult<T>> {
  const fetched = await settle(
    accept(
      fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Notion-Version": NOTION_VERSION,
        },
      }),
      [200, 401, 403, 404],
    ),
  );
  signal.throwIfAborted();
  if (!fetched.ok) {
    if (fetched.error instanceof HttpStatusError) {
      return {
        kind: "transient_error",
        status: fetched.error.status,
        message: await fetched.error.response.text(),
      };
    }
    return {
      kind: "transient_error",
      status: null,
      message: "Failed to reach Notion API",
    };
  }
  const response = fetched.value;
  if (response.status === 401) {
    return { kind: "unauthorized" };
  }
  if (response.status === 403 || response.status === 404) {
    return { kind: "not_found" };
  }

  const responseText = await tapError(response.text());
  signal.throwIfAborted();
  const json = safeJsonParse(responseText ?? "");
  if (json === undefined) {
    return {
      kind: "transient_error",
      status: response.status,
      message: "Failed to parse Notion API response",
    };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: "transient_error",
      status: response.status,
      message: "Unexpected Notion API response",
    };
  }
  return { kind: "ok", value: parsed.data };
}

export async function retrieveNotionPage(
  args: {
    readonly accessToken: string;
    readonly pageId: string;
  },
  signal: AbortSignal,
): Promise<NotionFetchResult<NotionPageResponse>> {
  return await notionFetchJson(
    notionPageResponseSchema,
    args.accessToken,
    `${NOTION_API_BASE}/pages/${args.pageId}`,
    signal,
  );
}

export async function retrieveNotionDataSource(
  args: {
    readonly accessToken: string;
    readonly dataSourceId: string;
  },
  signal: AbortSignal,
): Promise<NotionFetchResult<NotionDataSourceResponse>> {
  return await notionFetchJson(
    notionDataSourceResponseSchema,
    args.accessToken,
    `${NOTION_API_BASE}/data_sources/${args.dataSourceId}`,
    signal,
  );
}

async function retrieveNotionDatabase(
  args: {
    readonly accessToken: string;
    readonly databaseId: string;
  },
  signal: AbortSignal,
): Promise<NotionFetchResult<NotionDatabaseResponse>> {
  return await notionFetchJson(
    notionDatabaseResponseSchema,
    args.accessToken,
    `${NOTION_API_BASE}/databases/${args.databaseId}`,
    signal,
  );
}

export const prepareNotionChildPageEventConfigForPersist$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly eventConfig: NotionChildPageCreatedEventCreateConfig;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "ok";
        readonly eventConfig: NotionChildPageCreatedEventConfig;
      }
    | { readonly kind: "bad-request"; readonly message: string }
  > => {
    const parentPageId = parseStandardNotionPageUrl(
      args.eventConfig.parentPageUrl,
    );
    if (!parentPageId) {
      return {
        kind: "bad-request",
        message: "Enter a standard notion.so page URL",
      };
    }

    const accessResult = await set(
      resolveNotionCredentialAccess$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.connectorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (accessResult.kind !== "ok") {
      return { kind: "bad-request", message: accessResult.message };
    }

    const pageResult = await retrieveNotionPage(
      {
        accessToken: accessResult.access.accessToken,
        pageId: parentPageId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (pageResult.kind === "not_found" || pageResult.kind === "unauthorized") {
      return {
        kind: "bad-request",
        message: `${BRAND_PRESENTATION.assistantName} cannot access this Notion page`,
      };
    }
    if (pageResult.kind !== "ok") {
      return {
        kind: "bad-request",
        message: "Failed to validate Notion page URL",
      };
    }
    if (!pageIsUsable(pageResult.value)) {
      return {
        kind: "bad-request",
        message: "Notion page is archived or in trash",
      };
    }

    return {
      kind: "ok",
      eventConfig: {
        provider: "notion",
        event: "child_page_created",
        connectorId: accessResult.access.connectorId,
        parentPage: notionPageReference(
          pageResult.value,
          args.eventConfig.parentPageUrl,
        ),
      },
    };
  },
);

export const prepareNotionDatabaseItemEventConfigForPersist$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly eventConfig: NotionDatabaseItemCreatedEventCreateConfig;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "ok";
        readonly eventConfig: NotionDatabaseItemCreatedEventConfig;
      }
    | { readonly kind: "bad-request"; readonly message: string }
  > => {
    const notionId = parseStandardNotionUrlId(args.eventConfig.databaseUrl);
    if (!notionId) {
      return {
        kind: "bad-request",
        message: "Enter a standard notion.so database URL",
      };
    }

    const accessResult = await set(
      resolveNotionCredentialAccess$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.connectorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (accessResult.kind !== "ok") {
      return { kind: "bad-request", message: accessResult.message };
    }
    const accessToken = accessResult.access.accessToken;
    const retrieveDataSource = (dataSourceId: string) => {
      return retrieveNotionDataSource({ accessToken, dataSourceId }, signal);
    };

    const databaseResult = await retrieveNotionDatabase(
      {
        accessToken,
        databaseId: notionId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (databaseResult.kind === "ok") {
      const [firstDataSource] = databaseResult.value.data_sources;
      if (!firstDataSource) {
        return {
          kind: "bad-request",
          message: "Notion database does not expose a data source",
        };
      }
      const dataSourceResult = await retrieveDataSource(firstDataSource.id);
      signal.throwIfAborted();
      if (
        dataSourceResult.kind === "not_found" ||
        dataSourceResult.kind === "unauthorized"
      ) {
        return {
          kind: "bad-request",
          message: `${BRAND_PRESENTATION.assistantName} cannot access this Notion database`,
        };
      }
      if (dataSourceResult.kind !== "ok") {
        return {
          kind: "bad-request",
          message: "Failed to validate Notion database URL",
        };
      }
      return {
        kind: "ok",
        eventConfig: {
          provider: "notion",
          event: "database_item_created",
          connectorId: accessResult.access.connectorId,
          dataSource: notionDataSourceReference({
            dataSource: dataSourceResult.value,
            title:
              firstDataSource.name ??
              dataSourceResult.value.name ??
              notionDatabaseTitle(databaseResult.value),
            rawUrl: args.eventConfig.databaseUrl,
          }),
        },
      };
    }
    if (databaseResult.kind === "transient_error") {
      return {
        kind: "bad-request",
        message: "Failed to validate Notion database URL",
      };
    }

    const dataSourceResult = await retrieveDataSource(notionId);
    signal.throwIfAborted();
    if (
      dataSourceResult.kind === "not_found" ||
      dataSourceResult.kind === "unauthorized"
    ) {
      return {
        kind: "bad-request",
        message: `${BRAND_PRESENTATION.assistantName} cannot access this Notion database`,
      };
    }
    if (dataSourceResult.kind !== "ok") {
      return {
        kind: "bad-request",
        message: "Failed to validate Notion database URL",
      };
    }

    return {
      kind: "ok",
      eventConfig: {
        provider: "notion",
        event: "database_item_created",
        connectorId: accessResult.access.connectorId,
        dataSource: notionDataSourceReference({
          dataSource: dataSourceResult.value,
          title: dataSourceResult.value.name ?? null,
          rawUrl: args.eventConfig.databaseUrl,
        }),
      },
    };
  },
);

export const prepareNotionPageContentUpdatedEventConfigForPersist$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly eventConfig: NotionPageContentUpdatedEventCreateConfig;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "ok";
        readonly eventConfig: NotionPageContentUpdatedEventConfig;
      }
    | { readonly kind: "bad-request"; readonly message: string }
  > => {
    if (args.eventConfig.pageUrl !== undefined) {
      const pageResult = await set(
        prepareNotionChildPageEventConfigForPersist$,
        {
          orgId: args.orgId,
          userId: args.userId,
          connectorId: args.connectorId,
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: args.eventConfig.pageUrl,
          },
        },
        signal,
      );
      signal.throwIfAborted();
      if (pageResult.kind !== "ok") {
        return pageResult;
      }
      return {
        kind: "ok",
        eventConfig: {
          provider: "notion",
          event: "page_content_updated",
          connectorId: pageResult.eventConfig.connectorId,
          scope: {
            type: "page",
            page: pageResult.eventConfig.parentPage,
          },
        },
      };
    }

    if (args.eventConfig.databaseUrl === undefined) {
      return {
        kind: "bad-request",
        message: "Provide exactly one of pageUrl or databaseUrl",
      };
    }
    const dataSourceResult = await set(
      prepareNotionDatabaseItemEventConfigForPersist$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.connectorId,
        eventConfig: {
          provider: "notion",
          event: "database_item_created",
          databaseUrl: args.eventConfig.databaseUrl,
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (dataSourceResult.kind !== "ok") {
      return dataSourceResult;
    }
    return {
      kind: "ok",
      eventConfig: {
        provider: "notion",
        event: "page_content_updated",
        connectorId: dataSourceResult.eventConfig.connectorId,
        scope: {
          type: "data_source",
          dataSource: dataSourceResult.eventConfig.dataSource,
        },
      },
    };
  },
);

export const validateNotionEventConfigForConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly eventType: NotionAutomationEventType;
      readonly eventConfig: unknown;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "ok" }
    | { readonly kind: "bad-request"; readonly message: string }
  > => {
    const accessResult = await set(
      resolveNotionCredentialAccess$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.connectorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (accessResult.kind !== "ok") {
      return { kind: "bad-request", message: accessResult.message };
    }

    let resourceResult: NotionFetchResult<
      NotionPageResponse | NotionDataSourceResponse
    >;
    if (args.eventType === "notion-child-page-created") {
      const config = notionChildPageCreatedEventConfigSchema.safeParse(
        args.eventConfig,
      );
      if (!config.success || config.data.connectorId !== args.connectorId) {
        return {
          kind: "bad-request",
          message: "Notion automation account projection is out of date",
        };
      }
      resourceResult = await retrieveNotionPage(
        {
          accessToken: accessResult.access.accessToken,
          pageId: config.data.parentPage.id,
        },
        signal,
      );
    } else if (args.eventType === "notion-database-item-created") {
      const config = notionDatabaseItemCreatedEventConfigSchema.safeParse(
        args.eventConfig,
      );
      if (!config.success || config.data.connectorId !== args.connectorId) {
        return {
          kind: "bad-request",
          message: "Notion automation account projection is out of date",
        };
      }
      resourceResult = await retrieveNotionDataSource(
        {
          accessToken: accessResult.access.accessToken,
          dataSourceId: config.data.dataSource.id,
        },
        signal,
      );
    } else {
      const config = notionPageContentUpdatedEventConfigSchema.safeParse(
        args.eventConfig,
      );
      if (!config.success || config.data.connectorId !== args.connectorId) {
        return {
          kind: "bad-request",
          message: "Notion automation account projection is out of date",
        };
      }
      resourceResult =
        config.data.scope.type === "page"
          ? await retrieveNotionPage(
              {
                accessToken: accessResult.access.accessToken,
                pageId: config.data.scope.page.id,
              },
              signal,
            )
          : await retrieveNotionDataSource(
              {
                accessToken: accessResult.access.accessToken,
                dataSourceId: config.data.scope.dataSource.id,
              },
              signal,
            );
    }
    signal.throwIfAborted();
    if (
      resourceResult.kind === "ok" &&
      (resourceResult.value.object !== "page" ||
        pageIsUsable(resourceResult.value))
    ) {
      return { kind: "ok" };
    }
    return {
      kind: "bad-request",
      message:
        resourceResult.kind === "transient_error"
          ? "Failed to validate the Notion automation resource"
          : "The selected Notion account cannot access the automation resource",
    };
  },
);
