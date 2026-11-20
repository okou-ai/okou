import { command, computed, state } from "ccstate";
import type { Element } from "hast";
import { uploadsContract } from "@okouai/api-contracts/client/uploads";
import { artifactReferencesContract } from "@okouai/api-contracts/client/artifact-references";
import { artifactReferencePath } from "@okouai/api-contracts/validators/artifact-references";
import { artifactCatalogContract } from "@okouai/api-contracts/client/artifact-catalog";
import { connectorCatalogContract } from "@okouai/api-contracts/client/connector-catalog";
import type {
  PublicConnectorCatalogDetail,
  PublicConnectorCatalogAuthMethodDetail,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { GoogleDriveUploadMode } from "@okouai/core/google-workspace-conversion";
import { toast } from "@okouai/ui/components/ui/sonner";
import { accept } from "../lib/accept.ts";
import { fetchResource } from "../lib/resource-fetch.ts";
import {
  readMarkdownTable,
  writeTableWorkbook,
} from "../lib/markdown-table-workbook.ts";
import { triggerBlobDownload } from "../views/okou-page/attachment-url.ts";
import { i18n } from "../i18n/index.ts";
import { apiClient$ } from "./api-client.ts";
import { pageVersion$ } from "./page-signal.ts";
import { uploadArtifactToGoogleDrive$ } from "./chat-page/artifact-google-drive-sync.ts";
import {
  cancelBuiltinConnectorConnection$,
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  getOnlyAvailableCatalogBrowserAuthMethodDetail,
} from "./okou-page/settings/connectors.ts";

interface UploadedTable {
  readonly content: string;
  readonly artifactId: string;
}

// Weak keys follow parsed-table lifetimes; navigation drops the page cache.
// Save retries and the two Google destinations reuse the same immutable bytes.
const uploadedTables$ = computed((get) => {
  get(pageVersion$);
  return new WeakMap<Element, UploadedTable>();
});

const uploadTable$ = command(
  async ({ get }, workbook: Blob, filename: string, signal: AbortSignal) => {
    const client = get(apiClient$)(uploadsContract);
    const prepared = await accept(
      client.preparePrivate({
        body: {
          filename,
          contentType: workbook.type,
          size: workbook.size,
          purpose: "artifact",
          requirePrivateArtifact: true,
        },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    if ("multipart" in prepared.body) {
      throw new Error("Expected a single-part table upload");
    }
    const uploaded = await fetchResource(
      prepared.body.uploadUrl,
      {
        method: "PUT",
        body: workbook,
        headers: {
          "content-type": prepared.body.contentType,
          ...prepared.body.uploadHeaders,
        },
      },
      signal,
    );
    if (!uploaded.ok) {
      toast.error(
        i18n.t(($) => {
          return $.markdown.tableExport.uploadFailed;
        }),
      );
      throw new Error(`Table upload failed: ${uploaded.status}`);
    }
    const completed = await accept(
      client.complete({
        body: { id: prepared.body.id },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    const owner = await accept(
      get(apiClient$)(artifactReferencesContract).ownerArtifact({
        params: {
          reference: artifactReferencePath(completed.body.id, filename).slice(
            "/artifacts/".length,
          ),
        },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    return owner.body.artifactId;
  },
);

interface TableGoogleSave {
  readonly table: Element;
  readonly artifactId: string;
  readonly filename: string;
  readonly threadId: string;
  readonly mode: GoogleDriveUploadMode;
}

export interface TableGoogleConnection {
  readonly params: TableGoogleSave;
  readonly connector: PublicConnectorCatalogDetail;
  readonly method: PublicConnectorCatalogAuthMethodDetail;
  readonly account:
    | { readonly intent: "add" }
    | { readonly intent: "reconnect"; readonly connectionId: string };
  readonly retryManually: boolean;
}

const saveTableFile$ = command(
  async (
    { set },
    params: TableGoogleSave & {
      readonly connectionId?: string;
    },
    connection: TableGoogleConnection | null,
    signal: AbortSignal,
  ) => {
    const result = await set(
      uploadArtifactToGoogleDrive$,
      {
        ...params,
        successMessage:
          params.mode === "google"
            ? i18n.t(($) => {
                return $.markdown.tableExport.savedSheets;
              })
            : i18n.t(($) => {
                return $.markdown.tableExport.savedDrive;
              }),
      },
      signal,
    );
    if (result.kind === "scope-required") {
      await set(
        offerTableConnection$,
        {
          params,
          account: {
            intent: "reconnect",
            connectionId: result.recovery.connectionId,
          },
          retryManually: true,
        },
        connection,
        signal,
      );
    }
  },
);

const pageTableConnection$ = computed((get) => {
  get(pageVersion$);
  return state<TableGoogleConnection | null>(null);
});

export const markdownTableConnection$ = computed((get) => {
  return get(get(pageTableConnection$));
});

export const closeMarkdownTableConnection$ = command(
  ({ get, set }, request: TableGoogleConnection, connecting: boolean) => {
    const connection$ = get(pageTableConnection$);
    if (get(connection$) !== request) {
      return;
    }
    if (connecting) {
      set(cancelBuiltinConnectorConnection$);
    }
    set(connection$, null);
  },
);

// The dialog's Connect click owns the fresh user gesture needed by Safari.
export const connectMarkdownTable$ = command(
  async ({ get, set }, request: TableGoogleConnection, signal: AbortSignal) => {
    const connection$ = get(pageTableConnection$);
    if (get(connection$) !== request) {
      return;
    }
    await set(
      connectBuiltinConnectorOAuthAuthCodeAndSettle$,
      {
        connectorSlug: "google-drive",
        method: request.method,
        options: {
          account: request.account,
          connectorIcon: request.connector.icon,
          connectorLabel: request.connector.label,
        },
        onSuccess: async (connectedAccountId, ownerSignal) => {
          ownerSignal.throwIfAborted();
          if (get(connection$) !== request) {
            return;
          }
          if (!request.retryManually) {
            await set(
              saveTableFile$,
              { ...request.params, connectionId: connectedAccountId },
              request,
              ownerSignal,
            );
          }
          if (get(connection$) === request) {
            set(connection$, null);
          }
        },
      },
      signal,
    );
  },
);

const offerTableConnection$ = command(
  async (
    { get, set },
    request: Pick<
      TableGoogleConnection,
      "params" | "account" | "retryManually"
    >,
    previous: TableGoogleConnection | null,
    signal: AbortSignal,
  ) => {
    const connection$ = get(pageTableConnection$);
    const catalog = await accept(
      get(apiClient$)(connectorCatalogContract).get({
        params: { connectorSlug: "google-drive" },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    const method = getOnlyAvailableCatalogBrowserAuthMethodDetail(
      catalog.body.connector,
    );
    signal.throwIfAborted();
    if (!method || get(connection$) !== previous) {
      toast.error(
        i18n.t(($) => {
          return $.markdown.tableExport.googleUnavailable;
        }),
      );
      return;
    }
    // Uploads and metadata requests can outlive browser user activation.
    // Ask for a fresh Connect click before opening provider authorization.
    set(connection$, {
      ...request,
      connector: catalog.body.connector,
      method,
    });
  },
);

const saveTableToGoogle$ = command(
  async ({ get, set }, params: TableGoogleSave, signal: AbortSignal) => {
    const detail = await accept(
      get(apiClient$)(artifactCatalogContract).get({
        params: { artifactId: params.artifactId },
        query: { chatThreadId: params.threadId, driveAccountModel: "chat" },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    const status = detail.body.googleDriveSync;
    const recovery =
      status?.status === "disconnected" ? status.recovery : undefined;
    if (status && status.status !== "disconnected") {
      await set(
        saveTableFile$,
        { ...params, connectionId: detail.body.googleDriveConnectionId },
        null,
        signal,
      );
      return;
    }
    if (recovery?.action !== "connect" && recovery?.action !== "reconnect") {
      toast.error(
        i18n.t(($) => {
          return $.markdown.tableExport.googleUnavailable;
        }),
      );
      return;
    }
    await set(
      offerTableConnection$,
      {
        params,
        account:
          recovery.action === "reconnect"
            ? { intent: "reconnect", connectionId: recovery.connectionId }
            : { intent: "add" },
        retryManually: false,
      },
      null,
      signal,
    );
  },
);

export const exportMarkdownTable$ = command(
  async (
    { get, set },
    table: Element,
    mode: "excel" | GoogleDriveUploadMode,
    threadId: string | undefined,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const rows = readMarkdownTable(table);
    const filename = `${i18n.t(($) => {
      return $.markdown.tableExport.filename;
    })}.xlsx`;
    const workbook = writeTableWorkbook(rows);
    if (mode === "excel") {
      triggerBlobDownload(workbook, filename, signal);
      return;
    }
    const cache = get(uploadedTables$);
    if (!threadId) {
      toast.error(
        i18n.t(($) => {
          return $.markdown.tableExport.googleUnavailable;
        }),
      );
      return;
    }
    const content = JSON.stringify(rows);
    const previous = cache.get(table);
    const artifactId =
      previous?.content === content
        ? previous.artifactId
        : await set(uploadTable$, workbook, filename, signal);
    signal.throwIfAborted();
    cache.set(table, { content, artifactId });
    await set(
      saveTableToGoogle$,
      { table, artifactId, filename, threadId, mode },
      signal,
    );
  },
);
