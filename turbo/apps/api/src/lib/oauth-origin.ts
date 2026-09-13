import { apiBackendUrl } from "./api-backend-url";
import { webUrl } from "./web-url";

const WEB_ORIGIN_HEADER = "x-okou-web-origin";

type HostRole = "api" | "www";

function isTrustedFirstPartyHost(hostname: string, role: HostRole): boolean {
  return (
    (role === "www" &&
      (hostname === "okou.ai" || hostname.endsWith(".okou.ai"))) ||
    hostname === `${role}.okou.ai` ||
    hostname === `${role}.vm6.ai` ||
    hostname.endsWith(`-${role}.vm6.ai`) ||
    hostname === `${role}.vm7.ai` ||
    hostname.endsWith(`-${role}.vm7.ai`)
  );
}

function isTrustedOrigin(origin: string, role: HostRole): boolean {
  if (!URL.canParse(origin)) {
    return false;
  }

  const url = new URL(origin);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return false;
  }

  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return url.protocol === "http:" || url.protocol === "https:";
  }

  return (
    url.protocol === "https:" && isTrustedFirstPartyHost(url.hostname, role)
  );
}

function isTrustedHostedOrigin(origin: string, role: HostRole): boolean {
  if (!URL.canParse(origin)) {
    return false;
  }

  const url = new URL(origin);
  return (
    url.protocol === "https:" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    isTrustedFirstPartyHost(url.hostname, role)
  );
}

function isTrustedWebOrigin(origin: string): boolean {
  return isTrustedOrigin(origin, "www");
}

function getTrustedOAuthWebOrigin(request: Request): string | null {
  const webOrigin = request.headers.get(WEB_ORIGIN_HEADER);
  return webOrigin && isTrustedWebOrigin(webOrigin)
    ? new URL(webOrigin).origin
    : null;
}

function isTrustedApiOrigin(origin: string): boolean {
  return isTrustedOrigin(origin, "api");
}

function canonicalSiblingOriginForHost(
  url: URL,
  fromRole: HostRole,
  toRole: HostRole,
): string | null {
  const leadingRole = `${fromRole}.`;
  const delimitedRole = `-${fromRole}.`;
  let hostname: string | null = null;
  if (url.hostname.startsWith(leadingRole)) {
    hostname = `${toRole}.${url.hostname.slice(leadingRole.length)}`;
  } else {
    const roleIndex = url.hostname.indexOf(delimitedRole);
    if (roleIndex !== -1) {
      const prefix = url.hostname.slice(0, roleIndex);
      const suffix = url.hostname.slice(roleIndex + delimitedRole.length);
      hostname = `${prefix}-${toRole}.${suffix}`;
    }
  }

  if (!hostname) {
    return null;
  }

  const siblingUrl = new URL(url.toString());
  siblingUrl.hostname = hostname;
  siblingUrl.protocol = "https:";
  siblingUrl.username = "";
  siblingUrl.password = "";
  siblingUrl.pathname = "/";
  siblingUrl.search = "";
  siblingUrl.hash = "";

  const isTrusted =
    toRole === "api"
      ? isTrustedApiOrigin(siblingUrl.origin)
      : isTrustedWebOrigin(siblingUrl.origin);
  if (!isTrusted) {
    return null;
  }
  return siblingUrl.origin;
}

export function getOAuthWebOrigin(_request: Request): string {
  return new URL(webUrl()).origin;
}

export function getOAuthApiOrigin(_request: Request): string {
  const backendUrl = apiBackendUrl();
  if (backendUrl) {
    const configuredApiOrigin = new URL(backendUrl).origin;
    if (isTrustedHostedOrigin(configuredApiOrigin, "api")) {
      return configuredApiOrigin;
    }
  }

  const canonicalApiOrigin = canonicalSiblingOriginForHost(
    new URL(webUrl()),
    "www",
    "api",
  );
  if (canonicalApiOrigin) {
    return canonicalApiOrigin;
  }

  return new URL(webUrl()).origin;
}

export function getOAuthCanonicalRedirectUrl(request: Request): string | null {
  if (getTrustedOAuthWebOrigin(request)) {
    return null;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin === new URL(webUrl()).origin) {
    return null;
  }

  const canonicalOrigin = canonicalSiblingOriginForHost(
    requestUrl,
    "api",
    "www",
  );
  if (!canonicalOrigin) {
    return null;
  }

  return new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    canonicalOrigin,
  ).toString();
}
