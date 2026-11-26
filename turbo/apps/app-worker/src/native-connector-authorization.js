const NATIVE_AUTHORIZATION_PATH = "/native/connector-authorization";
const APP_ID = "C5UWSXYB67.ai.okou.ios";
const ASSOCIATION = JSON.stringify({
  applinks: {
    details: [
      {
        appIDs: [APP_ID],
        components: [
          { "/": NATIVE_AUTHORIZATION_PATH },
          {
            "/": "/connectors/tiktok/callback",
            "?": { state: "ios-https-v1:app-tiktok:*" },
          },
        ],
      },
    ],
  },
  webcredentials: { apps: [APP_ID] },
});
const ATTEMPT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function nativeConnectorAuthorizationResponse(request, url) {
  const association =
    url.pathname === "/.well-known/apple-app-site-association";
  if (!association && url.pathname !== NATIVE_AUTHORIZATION_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new globalThis.Response(null, {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }
  if (association) {
    return new globalThis.Response(
      request.method === "HEAD" ? null : ASSOCIATION,
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
        },
      },
    );
  }

  const attemptId = url.searchParams.get("attemptId");
  if (
    !attemptId ||
    !ATTEMPT_ID.test(attemptId) ||
    [...url.searchParams].length !== 1
  ) {
    return new globalThis.Response("Invalid authorization return", {
      status: 400,
    });
  }
  // The authentication session normally intercepts this HTTPS URL. A manual
  // recovery link handles browsers that keep Universal Links on the website.
  // Neither the URL nor this page establishes that the attempt succeeded.
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Return to Okou</title></head>
<body><main><h1>Continue in Okou</h1><p>Return to the app to check your connection.</p><a href="ai.okou.ios://connector-authorization/${attemptId.toLowerCase()}">Return to Okou</a></main></body></html>`;
  return new globalThis.Response(request.method === "HEAD" ? null : html, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "private, no-store",
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy":
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
