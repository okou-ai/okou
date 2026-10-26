import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { command, computed, type Computed } from "ccstate";
import type { infer as zInfer } from "zod";
import {
  slackOrgStatusSchema,
  integrationsSlackContract,
} from "@okouai/api-contracts/contracts/integrations-slack";
import { integrationsSlackDownloadFileContract } from "@okouai/api-contracts/contracts/integrations";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { request$ } from "../context/hono";
import {
  slackOrgStatus,
  slackUserInstallation,
} from "../services/slack-data.service";
import { publishSlackAdminSignal$ } from "../services/slack-connect.service";
import {
  getFileInfo,
  isSlackApiClientError,
  isSlackFileShared,
} from "../../lib/slack-client";
import {
  fetchSlackFile,
  isSlackFileFetchError,
  MAX_SLACK_FILE_SIZE_BYTES,
} from "../external/slack-file-fetcher";
import type { SlackView } from "../external/slack-block-kit";
import { createSlackClient } from "../external/slack-message-client";
import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { decryptPersistentSecretValue } from "../services/crypto.utils";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { env } from "../../lib/env";
import { getOAuthApiOrigin } from "../../lib/oauth-origin";
import { OFFICIAL_SLACK_APP_NAME } from "../../lib/slack-official-app";
import type { RouteEntry } from "../route-entry";
import { bestEffort, settle } from "../utils";
import {
  removeSlackWorkspaceInstallation$,
  slackAccountConnection,
  slackWorkspaceIdentityEnabled,
} from "../services/slack-workspace-identity.service";

const slackStatusInput$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return {
    apiOrigin: getOAuthApiOrigin(get(request$).raw),
    orgId: auth.orgId,
    userId: auth.userId,
    orgRole: auth.orgRole,
  } as const;
});

const slackStatus$ = slackOrgStatus(slackStatusInput$);
const slackAccountOwner$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return { orgId: auth.orgId, userId: auth.userId };
});
const accountConnection$ = slackAccountConnection(slackAccountOwner$);
const accountConnectionEnabled$ =
  slackWorkspaceIdentityEnabled(slackAccountOwner$);

const getSlackStatusInner$ = computed(async (get) => {
  const status = await get(slackStatus$);

  const statusFields = status.isConnected
    ? {
        workspaceName: status.workspaceName,
        defaultAgentName: status.defaultAgentName,
      }
    : {
        installUrl: status.installUrl,
        connectUrl: status.connectUrl,
      };
  const body: zInfer<typeof slackOrgStatusSchema> = {
    isConnected: status.isConnected,
    isInstalled: status.isInstalled,
    isAdmin: status.isAdmin,
    ...(!status.isInstalled && status.installUrl
      ? { installUrl: status.installUrl }
      : {}),
    ...statusFields,
    ...(status.scopeMismatch !== null && {
      scopeMismatch: status.scopeMismatch,
      reinstallUrl: status.reinstallUrl,
    }),
  };

  return { status: 200 as const, body };
});

function contractErrorResponse(
  status: 403 | 404,
  message: string,
  code: "FORBIDDEN" | "NOT_FOUND",
) {
  return {
    status,
    body: { error: { message, code } },
  };
}

function buildConnectUrl(workspaceId: string, slackUserId: string): string {
  const params = new URLSearchParams({ w: workspaceId, u: slackUserId });
  return `${env("APP_URL")}${INTEGRATION_SETTINGS_PATHS.slack}?${params.toString()}`;
}

function buildDisconnectedAppHomeView(args: {
  readonly workspaceId: string;
  readonly slackUserId: string;
}): SlackView {
  const { assistantName } = BRAND_PRESENTATION;
  return {
    type: "home",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Welcome to ${assistantName}! :wave:`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Connect your AI agents to Slack and interact with them through messages.",
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: ":x: *Account not connected*" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Connect" },
            url: buildConnectUrl(args.workspaceId, args.slackUserId),
            action_id: "home_login_prompt",
            style: "primary",
          },
        ],
      },
    ],
  };
}

function buildUninstalledAppHomeView(): SlackView {
  const { assistantName, brandName } = BRAND_PRESENTATION;
  return {
    type: "home",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Welcome to ${assistantName}! :wave:`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Connect your AI agents to Slack and interact with them through messages.",
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:warning: *${OFFICIAL_SLACK_APP_NAME} is not installed for this workspace*\nAsk a workspace admin to install ${OFFICIAL_SLACK_APP_NAME} from the platform.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: `Open ${brandName} Settings` },
            url: `${env("APP_URL")}${INTEGRATION_SETTINGS_PATHS.slack}`,
            action_id: "home_open_settings",
            style: "primary",
          },
        ],
      },
    ],
  };
}

const deleteSlackIntegrationQuery$ = queryOf(
  integrationsSlackContract.disconnect,
);

function decryptSlackInstallationToken(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly encryptedBotToken: string;
}): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    return await decryptPersistentSecretValue(
      args.encryptedBotToken,
      await get(userFeatureSwitchContext(args.orgId, args.userId)),
    );
  });
}

const uninstallSlackIntegration$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [installation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      return contractErrorResponse(
        404,
        "No Slack installation found",
        "NOT_FOUND",
      );
    }

    const connections = await db
      .select({
        slackUserId: slackOrgConnections.slackUserId,
        userId: slackOrgConnections.userId,
      })
      .from(slackOrgConnections)
      .where(
        eq(slackOrgConnections.slackWorkspaceId, installation.slackWorkspaceId),
      );
    signal.throwIfAborted();

    if (connections.length > 0) {
      const client = createSlackClient(
        await get(
          decryptSlackInstallationToken({
            orgId: args.orgId,
            userId: args.userId,
            encryptedBotToken: installation.encryptedBotToken,
          }),
        ),
      );
      const view = buildUninstalledAppHomeView();
      await Promise.allSettled(
        connections.map((connection) => {
          return client.publishAppHome(connection.slackUserId, view);
        }),
      );
      signal.throwIfAborted();
    }

    await set(
      removeSlackWorkspaceInstallation$,
      installation.slackWorkspaceId,
      signal,
    );

    await set(
      publishSlackAdminSignal$,
      { orgId: args.orgId, topic: "slack:changed" },
      signal,
    );
    signal.throwIfAborted();

    await publishUserSignal(
      Array.from(
        new Set([
          args.userId,
          ...connections.map((connection) => {
            return connection.userId;
          }),
        ]),
      ),
      "slack:changed",
    );
    signal.throwIfAborted();

    return { status: 200 as const, body: { ok: true } };
  },
);

const disconnectSlackIntegration$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    if (await get(accountConnectionEnabled$)) {
      signal.throwIfAborted();
      const account = await get(accountConnection$);
      signal.throwIfAborted();
      if (!account) {
        return contractErrorResponse(
          404,
          "No Slack connection found",
          "NOT_FOUND",
        );
      }
      await db
        .delete(slackOrgConnections)
        .where(
          and(
            eq(slackOrgConnections.id, account.connection.id),
            eq(slackOrgConnections.userId, args.userId),
          ),
        );
      signal.throwIfAborted();
      await publishUserSignal([args.userId], "slack:changed");
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true } };
    }
    const [installation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      return contractErrorResponse(
        404,
        "No Slack connection found",
        "NOT_FOUND",
      );
    }

    const [connection] = await db
      .select({
        id: slackOrgConnections.id,
        slackUserId: slackOrgConnections.slackUserId,
      })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.userId, args.userId),
          eq(
            slackOrgConnections.slackWorkspaceId,
            installation.slackWorkspaceId,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!connection) {
      return contractErrorResponse(
        404,
        "No Slack connection found",
        "NOT_FOUND",
      );
    }

    await db
      .delete(slackOrgConnections)
      .where(eq(slackOrgConnections.id, connection.id));
    signal.throwIfAborted();

    const client = createSlackClient(
      await get(
        decryptSlackInstallationToken({
          orgId: args.orgId,
          userId: args.userId,
          encryptedBotToken: installation.encryptedBotToken,
        }),
      ),
    );
    await bestEffort(
      client.publishAppHome(
        connection.slackUserId,
        buildDisconnectedAppHomeView({
          workspaceId: installation.slackWorkspaceId,
          slackUserId: connection.slackUserId,
        }),
      ),
    );
    signal.throwIfAborted();

    await publishUserSignal([args.userId], "slack:changed");
    signal.throwIfAborted();

    return { status: 200 as const, body: { ok: true } };
  },
);

const deleteSlackIntegration$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(deleteSlackIntegrationQuery$);
    // Preserve initialization and error ordering before the admin check.
    set(writeDb$);

    if (query.action === "uninstall") {
      if (auth.orgRole !== "admin") {
        return contractErrorResponse(403, "Admin access required", "FORBIDDEN");
      }

      return await set(
        uninstallSlackIntegration$,
        { orgId: auth.orgId, userId: auth.userId },
        signal,
      );
    }

    return await set(
      disconnectSlackIntegration$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
  },
);

function jsonErrorResponse(
  status: number,
  message: string,
  code: string,
): Response {
  return new Response(JSON.stringify({ error: { message, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function slackApiErrorResponse(error: unknown): Response | null {
  if (!isSlackApiClientError(error)) {
    return null;
  }

  if (error.method === "files.info" && error.code === "file_not_found") {
    return jsonErrorResponse(
      404,
      `Slack file not found: ${error.code}`,
      "NOT_FOUND",
    );
  }

  return jsonErrorResponse(
    400,
    `Slack API error: ${error.code}`,
    "SLACK_ERROR",
  );
}

function slackFileFetchErrorResponse(error: unknown): Response | null {
  if (!isSlackFileFetchError(error)) {
    return null;
  }

  switch (error.code) {
    case "invalid-url": {
      return jsonErrorResponse(
        400,
        "Invalid Slack download URL",
        "BAD_REQUEST",
      );
    }
    case "too-large": {
      return jsonErrorResponse(
        413,
        `File exceeds maximum size of ${MAX_SLACK_FILE_SIZE_BYTES} bytes`,
        "PAYLOAD_TOO_LARGE",
      );
    }
    case "download-failed": {
      return jsonErrorResponse(
        502,
        `Failed to download file from Slack: ${error.statusCode ?? "unknown"}`,
        "BAD_GATEWAY",
      );
    }
    case "html-response": {
      return jsonErrorResponse(
        502,
        "Slack returned an unexpected response (likely expired token)",
        "BAD_GATEWAY",
      );
    }
  }

  return null;
}

const slackDownloadInstallationInput$ = computed(
  (
    get,
  ): {
    readonly orgId: string;
    readonly userId: string;
  } => {
    const auth = get(organizationAuthContext$);
    return { orgId: auth.orgId, userId: auth.userId };
  },
);
const slackDownloadInstallation$ = slackUserInstallation(
  slackDownloadInstallationInput$,
);

const getSlackDownloadFileInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    get(organizationAuthContext$);
    const query = get(queryOf(integrationsSlackDownloadFileContract.download));
    const fileId = query.file_id;

    if (!fileId) {
      return jsonErrorResponse(
        400,
        "file_id query parameter is required",
        "BAD_REQUEST",
      );
    }

    const installation = await get(slackDownloadInstallation$);
    signal.throwIfAborted();
    if (installation.kind !== "connected") {
      return jsonErrorResponse(
        404,
        "No Slack installation found for this org",
        "NOT_FOUND",
      );
    }

    const fileInfoResult = await settle(
      getFileInfo(installation.botToken, fileId, signal),
      signal,
    );
    if (!fileInfoResult.ok) {
      const response = slackApiErrorResponse(fileInfoResult.error);
      if (response) {
        return response;
      }
      throw fileInfoResult.error;
    }
    const fileInfo = fileInfoResult.value;
    if (fileInfo.id !== fileId) {
      return jsonErrorResponse(
        404,
        "Slack file is unavailable to your connected account",
        "NOT_FOUND",
      );
    }
    const access = await settle(
      isSlackFileShared(
        installation.botToken,
        installation.slackUserId,
        fileInfo,
        signal,
      ),
      signal,
    );
    if (!access.ok) {
      const response = slackApiErrorResponse(access.error);
      if (response) {
        return response;
      }
      throw access.error;
    }
    if (!access.value) {
      return jsonErrorResponse(
        404,
        "Slack file is unavailable to your connected account",
        "NOT_FOUND",
      );
    }

    const downloadUrl = fileInfo.url_private_download ?? fileInfo.url_private;
    if (!downloadUrl) {
      return jsonErrorResponse(
        404,
        "File does not have a downloadable URL",
        "NOT_FOUND",
      );
    }

    if (fileInfo.size > MAX_SLACK_FILE_SIZE_BYTES) {
      return jsonErrorResponse(
        413,
        `File exceeds maximum size of ${MAX_SLACK_FILE_SIZE_BYTES} bytes`,
        "PAYLOAD_TOO_LARGE",
      );
    }

    const fileResponseResult = await settle(
      fetchSlackFile(downloadUrl, installation.botToken, signal),
      signal,
    );
    if (!fileResponseResult.ok) {
      const response = slackFileFetchErrorResponse(fileResponseResult.error);
      if (response) {
        return response;
      }
      throw fileResponseResult.error;
    }
    const fileResponse = fileResponseResult.value;

    const responseContentType = fileResponse.headers.get("content-type") ?? "";
    if (responseContentType.includes("text/html")) {
      return jsonErrorResponse(
        502,
        "Slack returned an unexpected response (likely expired token)",
        "BAD_GATEWAY",
      );
    }

    const headers = new Headers();
    const contentLength = fileResponse.headers.get("content-length");
    const contentType =
      fileInfo.mimetype || responseContentType || "application/octet-stream";

    headers.set("Content-Type", contentType);
    headers.set("X-File-Name", encodeURIComponent(fileInfo.name ?? fileId));
    headers.set("X-File-Mimetype", contentType);
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }

    return new Response(fileResponse.body, { status: 200, headers });
  },
);

const slackReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const slackDownloadAuth = {
  ...slackReadAuth,
  requiredCapability: "slack:read",
} as const;

export const integrationsSlackRoutes: readonly RouteEntry[] = [
  {
    route: integrationsSlackContract.getStatus,
    handler: authRoute(slackReadAuth, getSlackStatusInner$),
  },
  {
    route: integrationsSlackContract.disconnect,
    handler: authRoute(slackReadAuth, deleteSlackIntegration$),
  },
  {
    route: integrationsSlackDownloadFileContract.download,
    handler: authRoute(slackDownloadAuth, getSlackDownloadFileInner$),
  },
];
