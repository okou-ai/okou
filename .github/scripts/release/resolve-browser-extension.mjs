#!/usr/bin/env node
/** Deployment-only resolution. Inputs/credentials are env-only; stdout is one UUID. */
import {
  BrowserExtensionRegistryError as ExtensionResolutionError,
  compareExtensionVersions,
  listOkouBrowserExtensions,
} from "./browser-extension-registry.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const extensions = await listOkouBrowserExtensions(providerOrigin(), key);
  let latest;
  let ambiguous = false;
  for (const item of extensions) {
    const difference = latest ? compareExtensionVersions(item, latest) : 1;
    if (difference > 0) {
      latest = item;
      ambiguous = false;
    } else if (difference === 0) {
      ambiguous = true;
    }
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
