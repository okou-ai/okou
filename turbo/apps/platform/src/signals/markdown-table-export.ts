import { command, computed, state } from "ccstate";
import type { Element } from "hast";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import {
  artifactReferencesContract,
  artifactReferencePath,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogDetail,
  type PublicConnectorCatalogAuthMethodDetail,
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
import {
  currentChatAgentRecordId$,
  currentChatThreadId$,
} from "./agent-chat.ts";
import { pageVersion$ } from "./page-signal.ts";
import { syncArtifactAndRefresh$ } from "./chat-page/artifact-google-drive-sync.ts";
import {
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
  readonly agentId: string;
  readonly threadId: string;
  readonly mode: GoogleDriveUploadMode;
}

interface TableGoogleConnection {
  readonly params: TableGoogleSave;
  readonly connector: PublicConnectorCatalogDetail;
  readonly method: PublicConnectorCatalogAuthMethodDetail;
  readonly account:
    | { readonly intent: "add" }
    | { readonly intent: "reconnect"; readonly connectionId: string };
}

const pageTableConnection$ = computed((get) => {
  get(pageVersion$);
  return state<TableGoogleConnection | null>(null);
});

export const markdownTableConnection$ = computed((get) => {
  return get(get(pageTableConnection$));
});

export const closeMarkdownTableConnection$ = command(({ get, set }) => {
  set(get(pageTableConnection$), null);
});

// The dialog's Connect click owns the fresh user gesture needed by Safari.
export const connectMarkdownTable$ = command(
  async ({ set }, request: TableGoogleConnection, signal: AbortSignal) => {
    await set(
      connectBuiltinConnectorOAuthAuthCodeAndSettle$,
      {
        connectorSlug: "google-drive",
        method: request.method,
        options: {
          account: request.account,
          agentId: request.params.agentId,
          connectorIcon: request.connector.icon,
          connectorLabel: request.connector.label,
        },
        onSuccess: async (connectedAccountId, ownerSignal) => {
          await set(
            syncArtifactAndRefresh$,
            {
              ...request.params,
              connectionId: connectedAccountId,
              authorize: false,
            },
            ownerSignal,
          );
          set(closeMarkdownTableConnection$);
        },
      },
      signal,
    );
  },
);

const saveTableToGoogle$ = command(
  async ({ get, set }, params: TableGoogleSave, signal: AbortSignal) => {
    const detail = await accept(
      get(apiClient$)(artifactCatalogContract).get({
        params: { artifactId: params.artifactId },
        query: { chatThreadId: params.threadId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    const status = detail.body.googleDriveSync;
    const recovery =
      status?.status === "disconnected" ? status.recovery : undefined;
    const connectionId = detail.body.googleDriveConnectionId;
    if (status && status.status !== "disconnected") {
      await set(
        syncArtifactAndRefresh$,
        { ...params, connectionId, authorize: false },
        signal,
      );
      return;
    }
    if (recovery?.action === "authorize") {
      await set(
        syncArtifactAndRefresh$,
        { ...params, connectionId, authorize: true },
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
    if (!method) {
      toast.error(
        i18n.t(($) => {
          return $.markdown.tableExport.googleUnavailable;
        }),
      );
      return;
    }
    // Uploads and metadata requests can outlive browser user activation.
    // Ask for a fresh Connect click before opening provider authorization.
    set(get(pageTableConnection$), {
      params,
      connector: catalog.body.connector,
      method,
      account:
        recovery.action === "reconnect"
          ? { intent: "reconnect", connectionId: recovery.connectionId }
          : { intent: "add" },
    });
  },
);

export const exportMarkdownTable$ = command(
  async (
    { get, set },
    table: Element,
    mode: "excel" | GoogleDriveUploadMode,
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
    const threadId = get(currentChatThreadId$);
    const cache = get(uploadedTables$);
    const agentId = await get(currentChatAgentRecordId$);
    signal.throwIfAborted();
    if (!threadId || !agentId) {
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
      { table, artifactId, filename, agentId, threadId, mode },
      signal,
    );
  },
);
