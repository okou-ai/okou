import { command } from "ccstate";
import { integrationsGithubDownloadFileContract } from "@okouai/api-contracts/contracts/integrations";

import { inferMimetype } from "../../lib/mimetype";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { safeUriComponentDecode } from "../utils";

function jsonResponse(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, code } }, { status });
}

const GITHUB_ASSET_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const GITHUB_CONTENT_HOSTS = [
  "objects.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "raw.githubusercontent.com",
  "user-images.githubusercontent.com",
] as const;

function normalizeGithubDownloadUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/u, "");
}

function isAllowedGithubDownloadUrl(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "github.com") {
    return (
      parsed.pathname.startsWith("/user-attachments/assets/") ||
      parsed.pathname.startsWith("/user-attachments/files/")
    );
  }

  return GITHUB_CONTENT_HOSTS.some((host) => {
    return host === hostname;
  });
}

function filenameFromGithubDownloadUrl(url: string): string | null {
  const parsed = new URL(url);
  const segment = parsed.pathname.split("/").filter(Boolean).pop();
  if (!segment || GITHUB_ASSET_ID_RE.test(segment)) {
    return null;
  }
  return segment;
}

function sanitizeDownloadFilename(filename: string): string {
  return filename.trim().replace(/[/\\]/gu, "_").slice(0, 255) || "github-file";
}

const fileUrl$ = command(({ get }) => {
  const query = get(queryOf(integrationsGithubDownloadFileContract.fileUrl));
  // Keep signed query parameters byte-for-byte; punctuation cleanup applies
  // only to bare attachment links copied from prose.
  const downloadUrl = new URL(query.url).search
    ? query.url
    : normalizeGithubDownloadUrl(query.url);
  const parsed = new URL(downloadUrl);
  if (
    !isAllowedGithubDownloadUrl(downloadUrl) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hash !== ""
  ) {
    return jsonResponse(
      400,
      "Only GitHub file attachment URLs can be downloaded",
      "BAD_REQUEST",
    );
  }
  const urlFilename = filenameFromGithubDownloadUrl(downloadUrl);
  const decodedFilename = urlFilename
    ? (safeUriComponentDecode(urlFilename) ?? urlFilename)
    : urlFilename;
  const filename = sanitizeDownloadFilename(
    (query.filename ?? decodedFilename ?? "github-file").replace(
      /\p{Cc}/gu,
      "",
    ),
  );
  const safeFilename =
    filename === "." || filename === ".." ? "github-file" : filename;
  return Response.json(
    {
      downloadUrl,
      filename: safeFilename,
      contentType: inferMimetype(safeFilename),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
});

const githubReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "github:read",
} as const;

export const integrationsGithubDownloadFileRoutes: readonly RouteEntry[] = [
  {
    route: integrationsGithubDownloadFileContract.fileUrl,
    handler: authRoute(githubReadAuth, fileUrl$),
  },
];
