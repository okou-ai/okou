import {
  artifactCatalogContract,
  type ArtifactCatalogListQuery,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { builtinConnectorsMainContract } from "@okouai/api-contracts/contracts/connectors";
import {
  chatThreadArtifactsContract,
  type ChatThreadArtifactRun,
} from "@okouai/api-contracts/contracts/chat-threads";

import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

export const NAVIGATION_ARTIFACT_THREAD_ID =
  "b0000000-0000-4000-a000-000000000920";
export const NAVIGATION_ARTIFACT_AGENT_ID =
  "c0000000-0000-4000-a000-000000000001";
export const NAVIGATION_ARTIFACT_RUN_ID = "navigation-artifact-run";
const GOOGLE_DRIVE_CONNECTION_ID = "d0000000-0000-4000-a000-000000000921";

const CREATED_AT = "2026-09-01T12:00:00.000Z";
const UPDATED_AT = "2026-09-01T12:01:00.000Z";

export function artifactSummary(
  id: string,
  kind: ArtifactSummary["kind"],
  title: string,
): ArtifactSummary {
  return {
    id,
    kind,
    title,
    thumbnail: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

export function fileArtifactDetail(
  summary: ArtifactSummary,
  options: {
    readonly contentType: string;
    readonly fileId: string;
    readonly filename: string;
    readonly url: string;
  },
): ArtifactDetail {
  return {
    ...summary,
    kind: "file",
    file: {
      id: options.fileId,
      filename: options.filename,
      contentType: options.contentType,
      size: 128,
      url: options.url,
      previewImageUrl: null,
    },
  };
}

export function imageArtifactDetail(
  summary: ArtifactSummary,
  options: {
    readonly fileId: string;
    readonly filename: string;
    readonly url: string;
  },
): ArtifactDetail {
  return {
    ...summary,
    kind: "image",
    file: {
      id: options.fileId,
      filename: options.filename,
      contentType: "image/png",
      size: 1024,
      url: options.url,
      previewImageUrl: null,
    },
    model: "gpt-image-1",
    provider: "openai",
  };
}

export function hostedSiteArtifactDetail(
  summary: ArtifactSummary,
  options: {
    readonly siteId: string;
    readonly slug: string;
    readonly url: string;
  },
): ArtifactDetail {
  return {
    ...summary,
    kind: "hosted-site",
    site: {
      id: options.siteId,
      slug: options.slug,
      publicSlug: options.slug,
      url: options.url,
      deploymentVersion: 3,
      entrypoint: "index.html",
      spaFallback: true,
    },
  };
}

export function artifactRun(options: {
  readonly contentType: string;
  readonly fileId: string;
  readonly filename: string;
  readonly googleDriveSync?: ChatThreadArtifactRun["files"][number]["googleDriveSync"];
  readonly url: string;
}): ChatThreadArtifactRun {
  return {
    runId: NAVIGATION_ARTIFACT_RUN_ID,
    files: [
      {
        id: options.fileId,
        filename: options.filename,
        contentType: options.contentType,
        size: 128,
        url: options.url,
        createdAt: CREATED_AT,
        ...(options.googleDriveSync === undefined
          ? {}
          : { googleDriveSync: options.googleDriveSync }),
      },
    ],
  };
}

interface MockArtifactConversationOptions {
  readonly artifactRuns?: () => readonly ChatThreadArtifactRun[];
  readonly browserSession?: () => BrowserSession | null;
  readonly catalog: readonly ArtifactSummary[];
  readonly chatEvents?: MockChatEventInput[];
  readonly details?: ReadonlyMap<string, ArtifactDetail | null>;
  readonly activeRunIds?: readonly string[];
  readonly onCatalogList?: (query: ArtifactCatalogListQuery) => void;
}

export function mockArtifactConversation(
  context: TestContext,
  options: MockArtifactConversationOptions,
): void {
  mockChatLifecycle(context, {
    threadId: NAVIGATION_ARTIFACT_THREAD_ID,
    threadTitle: "Artifact navigation",
    chatEvents: options.chatEvents,
    activeRunIds: options.activeRunIds ? [...options.activeRunIds] : undefined,
  });

  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    options.onCatalogList?.(query);
    return respond(200, {
      artifacts: [...options.catalog],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    const detail = options.details?.get(params.artifactId) ?? null;
    return detail === null
      ? respond(404, {
          error: {
            code: "ARTIFACT_NOT_FOUND",
            message: "Artifact not found",
          },
        })
      : respond(200, detail);
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, {
      runs: [...(options.artifactRuns?.() ?? [])],
    });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    const browser = options.browserSession?.() ?? null;
    return browser === null
      ? respond(404, {
          error: {
            code: "BROWSER_NOT_FOUND",
            message: "Managed browser not found",
          },
        })
      : respond(200, { browser });
  });
  context.mocks.api(builtinConnectorsMainContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [],
      connectorProvidedBindings: [],
    });
  });
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [] });
  });
}

export function liveBrowserSession(): BrowserSession {
  return {
    threadId: NAVIGATION_ARTIFACT_THREAD_ID,
    name: "background-research",
    status: "active",
    viewerUrl: "https://viewer.example.test/background-research",
    liveUrl: "https://viewer.example.test/live/background-research",
    screenshotUrl: null,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    screen: { width: 1440, height: 900, resizable: true },
    idleExpiresAt: "2026-09-01T12:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

export function googleDriveConnector(
  connectionStatus: BuiltinConnectorResponse["connectionStatus"],
): BuiltinConnectorResponse {
  return {
    id: GOOGLE_DRIVE_CONNECTION_ID,
    slug: "google-drive",
    authMethod: "oauth",
    externalId: "drive-account-1",
    externalUsername: "drive-user",
    externalEmail: "drive-user@example.test",
    oauthScopes: ["https://www.googleapis.com/auth/drive.file"],
    connectionStatus,
    reconnectReason:
      connectionStatus === "reconnect-required"
        ? "authorization_expired_or_revoked"
        : null,
    tokenExpiresAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

export function googleDriveCatalogItem(
  connectionStatus: PublicConnectorCatalogStatusItem["connectionStatus"],
): PublicConnectorCatalogStatusItem {
  const connected = connectionStatus === "connected";
  return {
    slug: "google-drive",
    label: "Google Drive",
    description: "Store generated files in Google Drive.",
    icon: {
      url: "https://icons.example.test/google-drive.svg",
      invertInDarkMode: false,
    },
    category: "storage",
    generation: [],
    tags: ["storage"],
    authMethods: [
      {
        id: "oauth",
        label: "Google",
        description: null,
        grantKind: "auth-code",
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection:
      connectionStatus === "not-connected"
        ? null
        : {
            id: GOOGLE_DRIVE_CONNECTION_ID,
            authMethod: "oauth",
            externalUsername: "drive-user",
            externalEmail: "drive-user@example.test",
            reconnectReason:
              connectionStatus === "reconnect-required"
                ? "authorization_expired_or_revoked"
                : null,
          },
    connected,
    connectionStatus,
    scopeMismatch: false,
    authMethodSupportsRefresh: true,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
  };
}

function queryButtonNamed(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.trim() === name
      );
    }) ?? null
  );
}

export function buttonNamed(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryButtonNamed(name, container);
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

export function roleItemNamed(
  role: "menuitem",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const item = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!item) {
    throw new Error(`${role} not found: ${name}`);
  }
  return item;
}
