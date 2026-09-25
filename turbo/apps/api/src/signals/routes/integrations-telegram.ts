import { command, computed } from "ccstate";
import {
  integrationsTelegramBotListContract,
  integrationsTelegramDownloadFileContract,
} from "@okouai/api-contracts/contracts/integrations";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";

import { allowedCorsOrigin } from "../../lib/cors";
import { env } from "../../lib/env";
import { inferMimetype } from "../../lib/mimetype";
import {
  organizationAuthContext$,
  requiredAuthContext$,
} from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { integrationsTelegramBotIdRoutes } from "./integrations-telegram-bot-id";
import { integrationsTelegramLinkRoutes } from "./integrations-telegram-link";
import {
  buildFileDownloadUrl,
  getFile,
  getUserProfilePhotos,
  type TelegramUserProfilePhoto,
} from "../external/telegram-client";
import { verifyTelegramBotAvatarUrlSignature } from "../external/telegram-avatar";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import {
  telegramIntegrationBots,
  telegramIntegrationLinkStatus,
  telegramBotToken,
  telegramBots,
  telegramInstallation,
} from "../services/telegram-data.service";
import {
  registerTelegramBot$,
  setupTelegramStatus$,
  telegramWebhook$,
} from "../services/telegram-post.service";
import { tapError } from "../utils";
import type { RouteEntry } from "../route-entry";

function errorResponse(
  status: number,
  message: string,
  code: string,
): Response {
  return new Response(JSON.stringify({ error: { message, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_AVATAR_SIZE_BYTES = 10 * 1024 * 1024;
const FALLBACK_AVATAR_SVG = [
  `<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Telegram bot avatar fallback">`,
  `<circle cx="20" cy="20" r="20" fill="#2AABEE" fill-opacity="0.1"/>`,
  `<svg x="10" y="10" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2AABEE" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">`,
  `<path d="M6 6a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -4"/>`,
  `<path d="M12 2v2"/>`,
  `<path d="M9 12v9"/>`,
  `<path d="M15 12v9"/>`,
  `<path d="M5 16l4 -2"/>`,
  `<path d="M15 14l4 2"/>`,
  `<path d="M9 18h6"/>`,
  `<path d="M10 8v.01"/>`,
  `<path d="M14 8v.01"/>`,
  `</svg>`,
  `</svg>`,
].join("");

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    return undefined;
  }
  return size;
}

function payloadTooLargeResponse(): Response {
  return errorResponse(
    413,
    `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
    "PAYLOAD_TOO_LARGE",
  );
}

function avatarPayloadTooLargeResponse(): Response {
  return errorResponse(
    413,
    `Avatar exceeds maximum size of ${MAX_AVATAR_SIZE_BYTES} bytes`,
    "PAYLOAD_TOO_LARGE",
  );
}

function fallbackAvatarResponse(): Response {
  const headers = new Headers();
  headers.set("Content-Type", "image/svg+xml; charset=utf-8");
  headers.set("Cache-Control", "private, max-age=300");
  return new Response(FALLBACK_AVATAR_SVG, { status: 200, headers });
}

function selectLargestProfilePhoto(
  photos: readonly TelegramUserProfilePhoto[],
): TelegramUserProfilePhoto | null {
  if (photos.length === 0) {
    return null;
  }

  return photos.reduce((largest, photo) => {
    return photo.width * photo.height > largest.width * largest.height
      ? photo
      : largest;
  }, photos[0]!);
}

function telegramProfileUserId(botId: string): string | number {
  const numericBotId = Number(botId);
  if (Number.isSafeInteger(numericBotId) && String(numericBotId) === botId) {
    return numericBotId;
  }
  return botId;
}

const telegramReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "telegram:read",
} as const;

const telegramSetupAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const getTelegramBotsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const bots = await get(
    telegramBots({ orgId: auth.orgId, userId: auth.userId }),
  );

  return {
    status: 200 as const,
    body: { bots: [...bots] },
  };
});

const getIntegrationTelegramListInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const bots = await get(
    telegramIntegrationBots({ orgId: auth.orgId, userId: auth.userId }),
  );

  return {
    status: 200 as const,
    body: { bots: [...bots] },
  };
});

const getIntegrationTelegramLinkStatusInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(integrationsTelegramContract.getLinkStatus));
  return await get(
    telegramIntegrationLinkStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      botId: query.botId,
      origin: query.origin,
    }),
  );
});

const getTelegramDownloadFileInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(
      queryOf(integrationsTelegramDownloadFileContract.download),
    );

    let botToken: string | null | undefined;
    if (isOfficialTelegramBotId(query.bot_id)) {
      botToken = getOfficialTelegramBotConfig().botToken;
    } else {
      const installation = await get(
        telegramInstallation({ orgId: auth.orgId, botId: query.bot_id }),
      );
      signal.throwIfAborted();
      botToken = installation?.botToken;
    }

    if (!botToken) {
      return errorResponse(404, "Telegram bot not found", "NOT_FOUND");
    }

    const response = await tapError(
      downloadTelegramFile({ botToken, fileId: query.file_id }, signal),
    );
    signal.throwIfAborted();
    if (!response) {
      return errorResponse(
        502,
        "Failed to download file from Telegram",
        "BAD_GATEWAY",
      );
    }
    return response;
  },
);

async function downloadTelegramFile(
  args: {
    readonly botToken: string;
    readonly fileId: string;
  },
  signal: AbortSignal,
): Promise<Response> {
  const file = await getFile(args.botToken, args.fileId);
  signal.throwIfAborted();
  if (!file.file_path) {
    return errorResponse(
      404,
      "Telegram file does not have a downloadable path",
      "NOT_FOUND",
    );
  }
  if (file.file_size && file.file_size > MAX_FILE_SIZE_BYTES) {
    return payloadTooLargeResponse();
  }

  const fileName = file.file_path.split("/").pop() ?? args.fileId;
  const downloadUrl = buildFileDownloadUrl(args.botToken, file.file_path);
  const fileResponse = await fetch(downloadUrl, { signal });
  signal.throwIfAborted();
  if (!fileResponse.ok) {
    return errorResponse(
      502,
      `Failed to download file from Telegram: ${fileResponse.status}`,
      "BAD_GATEWAY",
    );
  }

  const responseContentType = fileResponse.headers.get("content-type") ?? "";
  if (responseContentType.includes("text/html")) {
    return errorResponse(
      502,
      "Telegram returned an unexpected response",
      "BAD_GATEWAY",
    );
  }

  const contentLength = fileResponse.headers.get("content-length");
  const contentLengthBytes = parseContentLength(contentLength);
  if (
    contentLengthBytes !== undefined &&
    contentLengthBytes > MAX_FILE_SIZE_BYTES
  ) {
    return payloadTooLargeResponse();
  }

  const mimetype = responseContentType || inferMimetype(fileName);
  const headers = new Headers();
  headers.set("Content-Type", mimetype);
  headers.set("X-File-Name", encodeURIComponent(fileName));
  headers.set("X-File-Mimetype", mimetype);
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  return new Response(fileResponse.body, { status: 200, headers });
}

const registerTelegramBotInner$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    return set(registerTelegramBot$, { auth }, signal);
  },
);

const setupTelegramStatusInner$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    return set(setupTelegramStatus$, { auth }, signal);
  },
);

const getIntegrationTelegramAvatar$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const pathParams = get(pathParamsOf(integrationsTelegramContract.avatar));
    const query = get(queryOf(integrationsTelegramContract.avatar));

    let botToken: string | null = null;
    let profileUserId: string | number = telegramProfileUserId(
      pathParams.botId,
    );

    const hasValidSignature = verifyTelegramBotAvatarUrlSignature({
      botId: pathParams.botId,
      expiresAt: query.exp,
      signature: query.sig,
    });

    if (hasValidSignature) {
      if (isOfficialTelegramBotId(pathParams.botId)) {
        const config = getOfficialTelegramBotConfig();
        if (config.botToken && config.botId) {
          botToken = config.botToken;
          profileUserId = telegramProfileUserId(config.botId);
        }
      } else {
        const installation = await get(
          telegramBotToken({ botId: pathParams.botId }),
        );
        signal.throwIfAborted();
        botToken = installation?.botToken ?? null;
      }
    } else {
      const auth = await set(requiredAuthContext$, telegramReadAuth, signal);
      signal.throwIfAborted();
      if ("status" in auth) {
        return new Response(JSON.stringify(auth.body), {
          status: auth.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (isOfficialTelegramBotId(pathParams.botId)) {
        const config = getOfficialTelegramBotConfig();
        if (config.botToken && config.botId) {
          botToken = config.botToken;
          profileUserId = telegramProfileUserId(config.botId);
        }
      } else {
        const installation =
          auth.orgId === undefined
            ? null
            : await get(
                telegramBotToken({
                  botId: pathParams.botId,
                  orgId: auth.orgId,
                }),
              );
        signal.throwIfAborted();
        botToken = installation?.botToken ?? null;
      }
    }

    if (!botToken) {
      return errorResponse(404, "Telegram bot not found", "NOT_FOUND");
    }

    const response = await tapError(
      loadTelegramAvatar({ botToken, profileUserId }, signal),
    );
    signal.throwIfAborted();
    if (!response) {
      return errorResponse(
        502,
        "Failed to load Telegram bot avatar",
        "BAD_GATEWAY",
      );
    }
    return response;
  },
);

async function loadTelegramAvatar(
  args: {
    readonly botToken: string;
    readonly profileUserId: string | number;
  },
  signal: AbortSignal,
): Promise<Response> {
  const photos = await getUserProfilePhotos(
    args.botToken,
    args.profileUserId,
    1,
  );
  const photo = selectLargestProfilePhoto(photos[0] ?? []);
  if (!photo) {
    return fallbackAvatarResponse();
  }

  if (photo.file_size && photo.file_size > MAX_AVATAR_SIZE_BYTES) {
    return avatarPayloadTooLargeResponse();
  }

  const file = await getFile(args.botToken, photo.file_id);
  signal.throwIfAborted();
  if (!file.file_path) {
    return fallbackAvatarResponse();
  }
  if (file.file_size && file.file_size > MAX_AVATAR_SIZE_BYTES) {
    return avatarPayloadTooLargeResponse();
  }

  const downloadResponse = await fetch(
    buildFileDownloadUrl(args.botToken, file.file_path),
    { signal },
  );
  signal.throwIfAborted();
  if (!downloadResponse.ok) {
    return errorResponse(
      502,
      `Failed to download avatar from Telegram: ${downloadResponse.status}`,
      "BAD_GATEWAY",
    );
  }

  const responseContentType =
    downloadResponse.headers.get("content-type") ?? "";
  if (responseContentType.includes("text/html")) {
    return errorResponse(
      502,
      "Telegram returned an unexpected response",
      "BAD_GATEWAY",
    );
  }

  const contentLength = downloadResponse.headers.get("content-length");
  const contentLengthBytes = parseContentLength(contentLength);
  if (
    contentLengthBytes !== undefined &&
    contentLengthBytes > MAX_AVATAR_SIZE_BYTES
  ) {
    return avatarPayloadTooLargeResponse();
  }

  const fileName = file.file_path.split("/").pop() ?? photo.file_id;
  const mimetype = responseContentType || inferMimetype(fileName);
  const headers = new Headers();
  headers.set("Content-Type", mimetype);
  headers.set("Cache-Control", "private, max-age=300");
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  return new Response(downloadResponse.body, {
    status: 200,
    headers,
  });
}

const getIntegrationTelegramAuthCallback$ = computed((get): Response => {
  const query = get(queryOf(integrationsTelegramContract.authCallback));
  const fallbackTargetOrigin = new URL(env("APP_URL")).origin;
  const targetOrigin = query.targetOrigin
    ? allowedCorsOrigin(query.targetOrigin)
    : fallbackTargetOrigin;
  if (!targetOrigin) {
    return new Response("Invalid target origin", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const serializedTargetOrigin = JSON.stringify(targetOrigin);
  const html = `<!DOCTYPE html>
<html><head><title>Telegram Auth</title></head>
<body><script>
(function() {
  var params = new URLSearchParams(window.location.search);
  if (!params.get("id")) {
    params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  }
  var targetOrigin = ${serializedTargetOrigin};
  var data = {};
  ["id","first_name","last_name","username","photo_url","auth_date","hash"].forEach(function(k) {
    var v = params.get(k);
    if (v !== null) data[k] = v;
  });
  if (window.opener && data.id) {
    window.opener.postMessage(
      { type: "telegram-auth", data: data },
      targetOrigin
    );
  }
  window.close();
})();
</script></body></html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

export const integrationsTelegramRoutes: readonly RouteEntry[] = [
  ...integrationsTelegramLinkRoutes,
  ...integrationsTelegramBotIdRoutes,
  {
    route: integrationsTelegramContract.list,
    handler: authRoute(telegramReadAuth, getIntegrationTelegramListInner$),
  },
  {
    route: integrationsTelegramContract.getLinkStatus,
    handler: authRoute(
      telegramReadAuth,
      getIntegrationTelegramLinkStatusInner$,
    ),
  },
  {
    route: integrationsTelegramContract.authCallback,
    handler: getIntegrationTelegramAuthCallback$,
  },
  {
    route: integrationsTelegramContract.register,
    handler: authRoute(telegramSetupAuth, registerTelegramBotInner$),
  },
  {
    route: integrationsTelegramContract.setupStatus,
    handler: authRoute(telegramSetupAuth, setupTelegramStatusInner$),
  },
  {
    route: integrationsTelegramContract.webhook,
    handler: telegramWebhook$,
  },
  {
    route: integrationsTelegramContract.avatar,
    handler: getIntegrationTelegramAvatar$,
  },
  {
    route: integrationsTelegramBotListContract.listBots,
    handler: authRoute(telegramReadAuth, getTelegramBotsInner$),
  },
  {
    route: integrationsTelegramDownloadFileContract.download,
    handler: authRoute(telegramReadAuth, getTelegramDownloadFileInner$),
  },
];
