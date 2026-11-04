/** Shared, read-only Browser Use inventory for publication and deployment. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BrowserExtensionRegistryError extends Error {}

function versionParts(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
    throw new BrowserExtensionRegistryError(
      "Invalid Okou Browser extension version",
    );
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger))
    throw new BrowserExtensionRegistryError(
      "Invalid Okou Browser extension version",
    );
  return parts;
}

export function compareExtensionVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    const difference = left.parts[index] - right.parts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function listOkouBrowserExtensions(origin, key) {
  const signal = AbortSignal.timeout(45_000);
  const pageSize = 100;
  const extensions = [];
  const ids = new Set();
  let total;
  let received = 0;
  for (let pageNumber = 1; ; pageNumber++) {
    const url = new URL("/api/v4/extensions", origin);
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("pageNumber", String(pageNumber));
    const response = await fetch(url, {
      headers: { "X-Browser-Use-API-Key": key },
      signal,
      redirect: "error",
    });
    if (!response.ok)
      throw new BrowserExtensionRegistryError(
        `Browser Use extension lookup failed (${response.status})`,
      );
    let page;
    try {
      page = await response.json();
    } catch {
      throw new BrowserExtensionRegistryError(
        "Browser Use returned invalid extension JSON",
      );
    }
    if (
      !page ||
      !Array.isArray(page.items) ||
      !Number.isSafeInteger(page.totalItems) ||
      page.totalItems < 0 ||
      page.pageNumber !== pageNumber ||
      page.pageSize !== pageSize ||
      (total !== undefined && page.totalItems !== total) ||
      page.items.length !== Math.min(pageSize, page.totalItems - received)
    ) {
      throw new BrowserExtensionRegistryError(
        "Browser Use returned inconsistent extension pagination",
      );
    }
    total = page.totalItems;
    received += page.items.length;
    for (const item of page.items) {
      if (item?.name !== "Okou Browser") continue;
      if (typeof item.id !== "string" || !uuid.test(item.id))
        throw new BrowserExtensionRegistryError(
          "Browser Use returned an invalid Okou Browser extension ID",
        );
      if (ids.has(item.id))
        throw new BrowserExtensionRegistryError(
          "Browser Use returned duplicate Okou Browser extension IDs",
        );
      ids.add(item.id);
      extensions.push({
        id: item.id,
        version: item.version,
        parts: versionParts(item.version),
      });
    }
    if (received === total) return extensions;
  }
}
