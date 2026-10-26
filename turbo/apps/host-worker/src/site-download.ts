import {
  HOSTED_SITE_FILES_PATH,
  HOSTED_SITE_FILE_DOWNLOAD_PATH,
} from "@okouai/api-contracts/contracts/hosted-site-download";

export function isSiteDownloadPath(pathname: string): boolean {
  return (
    pathname === HOSTED_SITE_FILES_PATH ||
    pathname === HOSTED_SITE_FILE_DOWNLOAD_PATH
  );
}

/** Download the authorized publication's original bytes, without injected chrome. */
export async function siteDownloadResponse(
  request: Request,
  publication: {
    readonly deploymentId: string;
    readonly siteUrl: string;
    readonly files: readonly {
      readonly path: string;
      readonly contentType: string;
    }[];
  },
  readFile: (path: string) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === HOSTED_SITE_FILES_PATH) {
    const files = publication.files.map((file) => {
      const download = new URL(HOSTED_SITE_FILE_DOWNLOAD_PATH, url.origin);
      download.searchParams.set("deploymentId", publication.deploymentId);
      download.searchParams.set("path", file.path);
      return { ...file, downloadUrl: download.href };
    });
    return new Response(
      request.method === "HEAD"
        ? null
        : JSON.stringify({
            publicSlug: new URL(publication.siteUrl).hostname.split(".")[0],
            files,
          }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-store",
        },
      },
    );
  }
  // An alias can be redeployed between listing and reading. Never mix versions.
  if (url.searchParams.get("deploymentId") !== publication.deploymentId) {
    return new Response("Website changed. Try downloading again.", {
      status: 409,
    });
  }
  const path = url.searchParams.get("path");
  const file = publication.files.find((member) => {
    return member.path === path;
  });
  if (!file) return new Response("Not found", { status: 404 });
  const response = await readFile(file.path);
  if (response.status !== 200) return response;
  const filename = encodeURIComponent(
    file.path.slice(file.path.lastIndexOf("/") + 1),
  ).replace(/[!'()*]/gu, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
  });
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${filename}`,
  );
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, headers });
}
