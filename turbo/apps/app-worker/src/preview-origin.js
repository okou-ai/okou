const PREVIEW_ALIAS_HOST =
  /^(staging|pr-[1-9][0-9]*)-app-okou-app-preview\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/u;
const PUBLIC_PREVIEW_ORIGIN =
  /^https:\/\/(staging|pr-[1-9][0-9]*)-app\.omby\.ai$/u;

export function isPreviewAlias(url) {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    PREVIEW_ALIAS_HOST.test(url.hostname)
  );
}

export function isBoundPublicPreview(url, env) {
  return (
    PUBLIC_PREVIEW_ORIGIN.test(env?.APP_PREVIEW_ORIGIN ?? "") &&
    url.origin === env.APP_PREVIEW_ORIGIN
  );
}

// A version-scoped binding authorizes one public identity, not arbitrary proxy
// headers. The upstream alias must belong to that same PR (or staging).
export function previewRequest(request, env) {
  const url = new globalThis.URL(request.url);
  const identity = PREVIEW_ALIAS_HOST.exec(url.hostname)?.[1];
  const origin = env?.APP_PREVIEW_ORIGIN;
  if (
    isPreviewAlias(url) &&
    origin === `https://${identity}-app.omby.ai` &&
    request.headers.get("x-forwarded-host") === `${identity}-app.omby.ai` &&
    request.headers.get("x-forwarded-proto") === "https"
  ) {
    url.host = `${identity}-app.omby.ai`;
  }

  // Do not let Clerk or downstream consumers reinterpret unvalidated forwarding
  // headers, including on direct workers.dev requests.
  const forwardingHeaders = [
    "forwarded",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
  ];
  if (
    !forwardingHeaders.some((name) => {
      return request.headers.has(name);
    })
  ) {
    return request;
  }
  const headers = new globalThis.Headers(request.headers);
  for (const name of forwardingHeaders) headers.delete(name);
  headers.set("Host", url.host);
  return new globalThis.Request(new globalThis.Request(url, request), {
    headers,
  });
}
