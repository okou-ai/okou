#!/usr/bin/env node
/** Deployment-only resolution. Inputs/credentials are env-only; stdout is one UUID. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class ExtensionResolutionError extends Error {}

function providerOrigin() {
  const url = new URL(
    process.env.BROWSER_USE_API_URL ?? "https://api.browser-use.com",
  );
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
  ) {
    throw new ExtensionResolutionError("Invalid Browser Use API origin");
  }
  return url.origin;
}

function versionParts(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
    throw new ExtensionResolutionError(
      "Invalid Okou Browser extension version",
    );
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger))
    throw new ExtensionResolutionError(
      "Invalid Okou Browser extension version",
    );
  return parts;
}

async function resolveExtension() {
  const released = process.env.BROWSER_EXTENSION_RELEASE_CREATED ?? "false";
  if (released === "true") {
    const id = process.env.BROWSER_EXTENSION_ID;
    if (!id || !uuid.test(id))
      throw new ExtensionResolutionError(
        "The extension release must provide a valid published ID",
      );
    return id;
  }
  if (released !== "false")
    throw new ExtensionResolutionError(
      "BROWSER_EXTENSION_RELEASE_CREATED must be true or false",
    );

  const key = process.env.OKOU_BROWSER_USE_API_KEY;
  if (!key)
    throw new ExtensionResolutionError("OKOU_BROWSER_USE_API_KEY is required");
  const origin = providerOrigin();
  const signal = AbortSignal.timeout(45_000);
  const pageSize = 100;
  let total;
  let received = 0;
  let latest;
  let ambiguous = false;
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
      throw new ExtensionResolutionError(
        `Browser Use extension lookup failed (${response.status})`,
      );
    const page = await response.json();
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
      throw new ExtensionResolutionError(
        "Browser Use returned inconsistent extension pagination",
      );
    }
    total = page.totalItems;
    received += page.items.length;
    for (const item of page.items) {
      if (item?.name !== "Okou Browser") continue;
      if (typeof item.id !== "string" || !uuid.test(item.id))
        throw new ExtensionResolutionError(
          "Browser Use returned an invalid Okou Browser extension ID",
        );
      const parts = versionParts(item.version);
      const difference = latest
        ? parts.findIndex((part, index) => part !== latest.parts[index])
        : -1;
      if (
        !latest ||
        (difference !== -1 && parts[difference] > latest.parts[difference])
      ) {
        latest = { id: item.id, parts };
        ambiguous = false;
      } else if (difference === -1 && item.id !== latest.id) {
        ambiguous = true;
      }
    }
    if (received === total) break;
  }
  if (!latest)
    throw new ExtensionResolutionError(
      "No uploaded Okou Browser extension was found",
    );
  if (ambiguous)
    throw new ExtensionResolutionError(
      "The highest Okou Browser extension version is ambiguous",
    );
  return latest.id;
}

try {
  console.log(await resolveExtension());
} catch (error) {
  // Provider/network errors may contain request details. Emit only owned diagnostics.
  console.error(
    error instanceof ExtensionResolutionError
      ? error.message
      : "Browser Use extension lookup did not complete",
  );
  process.exitCode = 1;
}
