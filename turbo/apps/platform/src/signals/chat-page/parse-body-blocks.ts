import { resolveApiBase } from "../api-base.ts";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { isArtifactPublicationFilePath } from "@okouai/api-contracts/contracts/artifact-delivery";
import { privateHostedDeploymentId } from "@okouai/core/private-hosted-artifact";
import {
  parseConnectorAuthorizeUrl,
  type ConnectorActionDescriptor,
} from "./connector-action-block.ts";
import {
  connectorAccountActionResourceKey,
  parseConnectorAccountActionUrl,
  type ConnectorAccountActionDescriptor,
} from "./connector-account-action-block.ts";
import type { ChatActionContext } from "./chat-action-context.ts";
import {
  parsePermissionActionUrl,
  permissionActionResourceKey,
  type PermissionActionDescriptor,
} from "./permission-action-block.ts";
import {
  bankingActionResourceKey,
  parseBankingActionUrl,
  type BankingActionDescriptor,
} from "./banking-action-block.ts";
import {
  parseComputerUseAuthorizationUrl,
  type ComputerUseAuthorizationDescriptor,
} from "./computer-use-authorization-block.ts";
import {
  parsePlanUpgradeUrl,
  type PlanUpgradeDescriptor,
} from "./plan-upgrade-block.ts";
import type { ArtifactKind } from "./artifact-card-signals.ts";
import { parseMailDraftUrl, type MailDraftDescriptor } from "./mail-draft.ts";
import {
  parseBrowserSessionUrl,
  type BrowserSessionDescriptor,
} from "./browser-session-block.ts";
import { isTrustedPlatformHostname } from "./trusted-platform-url.ts";
import { isOfficialTemplatePreviewUrl } from "./official-template-preview.ts";

import {
  resolveHostedSiteDomains,
  resolvePublicArtifactsBaseUrl,
} from "../../lib/platform-host.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BodyPreviewKind = ArtifactKind;

export interface ParsedMarkdownBlock {
  type: "markdown";
  id: string;
  content: string;
}

export type ParsedBodyBlock =
  | ParsedMarkdownBlock
  | {
      type: "connector-action";
      resourceKey: string;
      descriptor: ConnectorActionDescriptor;
    }
  | {
      type: "connector-account-action";
      resourceKey: string;
      descriptor: ConnectorAccountActionDescriptor;
    }
  | {
      type: "permission-action";
      resourceKey: string;
      descriptor: PermissionActionDescriptor;
    }
  | {
      type: "banking-action";
      resourceKey: string;
      descriptor: BankingActionDescriptor;
    }
  | {
      type: "unavailable-action";
      resourceKey: string;
      descriptor: { readonly originalUrl: string };
    }
  | {
      type: "computer-use-authorization";
      resourceKey: string;
      descriptor: ComputerUseAuthorizationDescriptor;
    }
  | {
      type: "plan-upgrade";
      resourceKey: string;
      descriptor: PlanUpgradeDescriptor;
    }
  | {
      type: "mail-draft";
      resourceKey: string;
      descriptor: MailDraftDescriptor;
    }
  | {
      type: "browser-session";
      resourceKey: string;
      descriptor: BrowserSessionDescriptor;
    };

type ChatAttachmentKind = BodyPreviewKind;

interface ChatAttachmentDescriptor {
  filename: string;
  url: string;
  contentType?: string;
}

type OpenMarkdownFence = {
  marker: "`" | "~";
  length: number;
};

interface ParseBodyBlocksOptions {
  readonly previews?: boolean;
  readonly chatActionContext?: ChatActionContext;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEGACY_PLATFORM_FILE_PATH_PATTERN =
  /^\/(?:f|artifacts)\/[^/]+\/[^/]+\/[^/]+$/;
const SHORT_ARTIFACT_FILE_PATH_PATTERN = /^\/artifacts\/[0-9a-z]{10}\.[^/]+$/;
// CDN and short links are both durable public artifact contracts. Only the
// short origin uses the flat path, so keep its recognition origin-exact.
const OKOU_SHORT_ARTIFACT_FILE_PATH_PATTERN = /^\/[0-9a-z]{10}\.[^/]+$/;
const OKOU_SHORT_ARTIFACT_ORIGINS: readonly string[] = Object.freeze([
  "https://a.okou.io",
  "https://files.sites.vm7.io",
]);
const PLATFORM_FILE_CDN_HOSTS = [
  "cdn.vm0.io",
  "cdn.okou.io",
  "cdn.vm7.io",
] as const;
const HOSTED_SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const URL_TOKEN_PATTERN = String.raw`(?:https?:\/\/|\/(?:agents|f|artifacts|browsers)\/|\/mail\/drafts\/|\/\?settings=billing&billingView=)[^\s<>"'()（）【】《》「」『』“”‘’，。；：！？、]+`;
const URL_TOKEN_OPENING_PREFIX_PATTERN = /^[({<"'“‘（【《「『[]*$/u;
const MARKDOWN_LINK_TOKEN_PREFIX_PATTERN = /\[[^\]\n]+\]\($/u;

// URL.canParse is unavailable on iOS Safari < 17. Instead of relying on it (or
// on try/catch, which this repo's ESLint forbids), feature-detect it and fall
// back to a structural validation before constructing a URL. Mirrors the
// pattern used in signals/auth.ts parseUrl(): the host must match a hostname
// shape with an in-range optional port, so malformed absolute URLs (for
// example "https://exa%mple.com") return null instead of throwing on old
// browsers. Remove together with support for URL.canParse-less browsers.
const LEGACY_HTTP_URL_REGEX = /^https?:\/\/([^/?#\s]+)([/?#][^\s]*)?$/i;
const LEGACY_HOST_WITH_OPTIONAL_PORT_REGEX =
  /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::(\d{1,5}))?$/i;
const MAX_URL_PORT = 65_535;
const PROTOCOL_RELATIVE_URL_REGEX = /^\/\/([^/?#\s]+)([/?#][^\s]*)?$/;

function isLegacyUrlHostValid(host: string | undefined): host is string {
  if (!host) {
    return false;
  }
  const hostMatch = LEGACY_HOST_WITH_OPTIONAL_PORT_REGEX.exec(host);
  const port = hostMatch?.[2];
  return Boolean(hostMatch && (!port || Number(port) <= MAX_URL_PORT));
}

function tryParseUrl(input: string, base?: string): URL | null {
  if (typeof URL.canParse === "function") {
    return URL.canParse(input, base) ? new URL(input, base) : null;
  }

  if (/\s/u.test(input)) {
    return null;
  }

  const absoluteMatch = LEGACY_HTTP_URL_REGEX.exec(input);
  if (absoluteMatch) {
    if (!isLegacyUrlHostValid(absoluteMatch[1])) {
      return null;
    }
    return new URL(input);
  }

  if (base && input.startsWith("/")) {
    if (input.startsWith("//")) {
      const protocolRelativeMatch = PROTOCOL_RELATIVE_URL_REGEX.exec(input);
      if (
        !protocolRelativeMatch ||
        !isLegacyUrlHostValid(protocolRelativeMatch[1])
      ) {
        return null;
      }
    }
    return new URL(input, base);
  }
  return null;
}

// ---------------------------------------------------------------------------
// classifyChatAttachment helpers
// ---------------------------------------------------------------------------

function fileExt(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function normalizeType(contentType?: string): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase();
}

const CHAT_KIND_BY_CONTENT_TYPE: Readonly<Record<string, BodyPreviewKind>> = {
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/plain": "text",
  "text/tab-separated-values": "text",
  "text/xml": "text",
  "text/yaml": "text",
  "text/x-yaml": "text",
  "application/xml": "text",
  "application/yaml": "text",
  "application/x-yaml": "text",
  "application/json": "json",
  "text/csv": "csv",
  "application/pdf": "pdf",
  "text/html": "html",
} as const;

const CHAT_KIND_BY_EXTENSION: Readonly<Record<string, BodyPreviewKind>> = {
  md: "markdown",
  txt: "text",
  log: "text",
  xml: "text",
  yaml: "text",
  yml: "text",
  tsv: "text",
  json: "json",
  csv: "csv",
  pdf: "pdf",
  html: "html",
  htm: "html",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  avif: "image",
  heic: "image",
  heif: "image",
  tif: "image",
  tiff: "image",
  psd: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  ogv: "video",
  mp3: "audio",
  wav: "audio",
  wave: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  flac: "audio",
  mpga: "audio",
} as const;

function mediaKindFromContentType(type: string): BodyPreviewKind | null {
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }
  return null;
}

export function classifyChatAttachment(
  attachment: ChatAttachmentDescriptor,
): ChatAttachmentKind {
  const type = normalizeType(attachment.contentType);
  const ext = fileExt(attachment.filename);
  const mediaKind = mediaKindFromContentType(type);

  if (mediaKind) {
    return mediaKind;
  }

  return (
    CHAT_KIND_BY_CONTENT_TYPE[type] ?? CHAT_KIND_BY_EXTENSION[ext] ?? "file"
  );
}

function isAuthenticatedFileUrl(url: URL): boolean {
  return (
    url.pathname === "/api/web/download-file" &&
    url.username === "" &&
    url.password === "" &&
    Boolean(url.searchParams.get("file_id")) &&
    browserHost() !== null &&
    url.origin === new URL(resolveApiBase()).origin
  );
}

function filenameFromUrl(url: string): string {
  const parsed = tryParseUrl(url);
  if (parsed && isAuthenticatedFileUrl(parsed)) {
    const filename = parsed.searchParams.get("filename");
    if (filename) {
      return filename;
    }
  }
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").pop();
  if (!last || last.length === 0) {
    return "file";
  }
  return last;
}

export function contentTypeForBodyPreviewKind(kind: BodyPreviewKind): string {
  if (kind === "markdown") {
    return "text/markdown";
  }
  if (kind === "text") {
    return "text/plain";
  }
  if (kind === "json") {
    return "application/json";
  }
  if (kind === "csv") {
    return "text/csv";
  }
  if (kind === "pdf") {
    return "application/pdf";
  }
  if (kind === "html") {
    return "text/html";
  }
  if (kind === "image") {
    return "image/*";
  }
  if (kind === "audio") {
    return "audio/*";
  }
  if (kind === "file") {
    return "application/octet-stream";
  }
  return "video/*";
}

// ---------------------------------------------------------------------------
// URL / line parsing
// ---------------------------------------------------------------------------

type PlatformHostTarget = "api" | "www" | "app" | "platform";

function browserHost(): string | null {
  if (typeof location === "undefined" || !location.host) {
    return null;
  }
  return location.host;
}

function rewritePlatformHostname(
  hostname: string,
  target: PlatformHostTarget,
): string {
  return hostname.replace(/(^|-)(platform|app|www|api)\./, `$1${target}.`);
}

function addPlatformFileHostVariants(hosts: Set<string>, host: string | null) {
  if (!host) {
    return;
  }

  hosts.add(host);

  const hostUrl = `https://${host}`;
  const parsed = tryParseUrl(hostUrl);
  if (!parsed) {
    return;
  }

  for (const target of ["api", "www", "app", "platform"] as const) {
    parsed.hostname = rewritePlatformHostname(parsed.hostname, target);
    hosts.add(parsed.host);
  }
}

function platformFileHosts(): Set<string> {
  const hosts = new Set<string>();
  addPlatformFileHostVariants(hosts, browserHost());
  addPlatformFileHostVariants(
    hosts,
    artifactsCdnHost(resolvePublicArtifactsBaseUrl()),
  );
  return hosts;
}

function isPlatformFileHostname(hostname: string): boolean {
  if (isTrustedPlatformHostname(hostname)) {
    return true;
  }
  return PLATFORM_FILE_CDN_HOSTS.some((host) => {
    return hostname === host;
  });
}

function artifactsCdnHost(baseUrl: string | undefined): string | null {
  if (!baseUrl) {
    return null;
  }
  const url = tryParseUrl(baseUrl);
  if (!url) {
    return null;
  }
  return url.host;
}

function hasExplicitUrlOrigin(url: string): boolean {
  return /^[a-z][a-z\d+\-.]*:\/\//i.test(url);
}

function isPlatformFileUrl(url: string): boolean {
  const host = browserHost();
  const baseUrl = host ? `https://${host}` : "https://relative.invalid";
  const parsed = tryParseUrl(url, baseUrl);
  if (!parsed) {
    return false;
  }
  if (isAuthenticatedFileUrl(parsed)) {
    return true;
  }
  const isLegacyPath = LEGACY_PLATFORM_FILE_PATH_PATTERN.test(parsed.pathname);
  const isShortArtifactPath = SHORT_ARTIFACT_FILE_PATH_PATTERN.test(
    parsed.pathname,
  );
  const isOkouShortArtifactPath =
    OKOU_SHORT_ARTIFACT_ORIGINS.includes(parsed.origin) &&
    parsed.username === "" &&
    parsed.password === "" &&
    (OKOU_SHORT_ARTIFACT_FILE_PATH_PATTERN.test(parsed.pathname) ||
      isArtifactPublicationFilePath(parsed.pathname));
  if (!isLegacyPath && !isShortArtifactPath && !isOkouShortArtifactPath) {
    return false;
  }
  if (!hasExplicitUrlOrigin(url)) {
    return isLegacyPath;
  }
  return (
    isOkouShortArtifactPath ||
    platformFileHosts().has(parsed.host) ||
    isPlatformFileHostname(parsed.hostname)
  );
}

function hostedSitePublicSlug(hostname: string): string | null {
  const normalizedHostname = hostname.toLowerCase();
  if (normalizedHostname === "files.sites.vm7.io") {
    return null;
  }
  for (const domain of resolveHostedSiteDomains()) {
    const suffix = `.${domain}`;
    if (!normalizedHostname.endsWith(suffix)) {
      continue;
    }
    const slug = normalizedHostname.slice(0, -suffix.length);
    if (HOSTED_SITE_SLUG_PATTERN.test(slug)) {
      return slug;
    }
  }
  return null;
}

export function isHostedSiteUrl(url: string): boolean {
  if (!hasExplicitUrlOrigin(url)) {
    return false;
  }

  const host = browserHost();
  const baseUrl = host ? `https://${host}` : "https://relative.invalid";
  const parsed = tryParseUrl(url, baseUrl);
  if (!parsed) {
    return false;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }

  return hostedSitePublicSlug(parsed.hostname) !== null;
}

function hostedSiteAttachment(
  url: string,
  title?: string,
): ChatAttachmentDescriptor | null {
  if (privateHostedDeploymentId(url, resolveApiBase())) {
    return {
      filename: title?.trim() || "Artifact.html",
      url,
      contentType: "text/html",
    };
  }
  const host = browserHost();
  const baseUrl = host ? `https://${host}` : "https://relative.invalid";
  const parsed = tryParseUrl(url, baseUrl);
  if (!parsed) {
    return null;
  }

  const publicSlug = hostedSitePublicSlug(parsed.hostname);
  if (!publicSlug) {
    return null;
  }

  return {
    filename: title?.trim() || url,
    url,
    contentType: "text/html",
  };
}

export function isPreviewableChatUrl(url: string): boolean {
  return (
    Boolean(
      parseArtifactReference(
        url,
        typeof location === "undefined" ? undefined : location.origin,
      ),
    ) ||
    Boolean(privateHostedDeploymentId(url, resolveApiBase())) ||
    isOfficialTemplatePreviewUrl(url) ||
    isPlatformFileUrl(url) ||
    isHostedSiteUrl(url)
  );
}

export function previewAttachmentFromUrl(
  url: string,
  title?: string,
): ChatAttachmentDescriptor {
  const hosted = hostedSiteAttachment(url, title);
  if (hosted) {
    return hosted;
  }

  const filename = filenameFromUrl(url);
  const trimmedTitle = title?.trim();
  if (trimmedTitle && /\.(?:html|htm)$/i.test(filename)) {
    return { filename: trimmedTitle, url, contentType: "text/html" };
  }
  return { filename, url };
}

function nextMarkdownFence(
  line: string,
  openFence: OpenMarkdownFence | null,
): OpenMarkdownFence | null {
  const fence = line.trim().match(/^(`{3,}|~{3,})/)?.[1];
  if (!fence) {
    return openFence;
  }
  const marker = fence.startsWith("`") ? "`" : "~";
  if (!openFence) {
    return { marker, length: fence.length };
  }
  return openFence.marker === marker && fence.length >= openFence.length
    ? null
    : openFence;
}

function stripMarkdownLineDecorations(value: string): string {
  let candidate = value
    .trim()
    .replace(/^(?:>\s*)+/, "")
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")
    .trim();
  const wrappers: [string, string][] = [
    ["**", "**"],
    ["__", "__"],
    ["*", "*"],
    ["_", "_"],
    ["~~", "~~"],
    ["`", "`"],
    ["<", ">"],
    ["(", ")"],
    ["（", "）"],
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const [prefix, suffix] of wrappers) {
      if (candidate.startsWith(prefix) && candidate.endsWith(suffix)) {
        candidate = candidate
          .slice(prefix.length, candidate.length - suffix.length)
          .trim();
        changed = true;
        break;
      }
    }
  }

  return candidate;
}

function trimPreviewUrl(value: string): string {
  let url = value.trim();
  let previous = "";
  while (url !== previous) {
    previous = url;
    url = url
      .replace(/[*_~`]+$/g, "")
      .replace(/[)\]}>.,，。；;:：!！?？]+$/g, "");
  }
  return url;
}

function hasUrlTokenBoundary(value: string, index: number): boolean {
  const prefix = value.slice(0, index);
  if (MARKDOWN_LINK_TOKEN_PREFIX_PATTERN.test(prefix)) {
    return true;
  }

  const tokenPrefix = /\S*$/u.exec(prefix)?.[0] ?? "";
  return URL_TOKEN_OPENING_PREFIX_PATTERN.test(tokenPrefix);
}

function extractUrlTokens(value: string): string[] {
  return Array.from(
    value.matchAll(new RegExp(URL_TOKEN_PATTERN, "g")),
    (match) => {
      return match.index !== undefined &&
        hasUrlTokenBoundary(value, match.index)
        ? trimPreviewUrl(match[0])
        : "";
    },
  ).filter((url, index, list) => {
    return url.length > 0 && list.indexOf(url) === index;
  });
}

function extractActionUrlFromLine(line: string): string | null {
  const candidate = stripMarkdownLineDecorations(line);
  const markdownLinkMatch = candidate.match(
    new RegExp(String.raw`^\[([^\]]+)\]\((${URL_TOKEN_PATTERN})\)$`),
  );
  const bareUrlMatch = candidate.match(new RegExp(`^(${URL_TOKEN_PATTERN})$`));
  if (markdownLinkMatch?.[2]) {
    return trimPreviewUrl(markdownLinkMatch[2]);
  }
  if (bareUrlMatch?.[1]) {
    return trimPreviewUrl(bareUrlMatch[1]);
  }

  const urls = extractUrlTokens(candidate);

  return urls.length === 1 ? urls[0]! : null;
}

function createActionBlockFromLine(
  line: string,
  chatActionContext: ChatActionContext | undefined,
): Extract<
  ParsedBodyBlock,
  {
    type:
      | "connector-action"
      | "connector-account-action"
      | "permission-action"
      | "banking-action"
      | "unavailable-action"
      | "computer-use-authorization"
      | "plan-upgrade"
      | "mail-draft"
      | "browser-session";
  }
> | null {
  const url = extractActionUrlFromLine(line);
  if (!url) {
    return null;
  }

  const connectorAction = parseConnectorAuthorizeUrl(url, chatActionContext);
  if (connectorAction.status === "valid") {
    return {
      type: "connector-action",
      resourceKey: connectorAction.descriptor.originalUrl,
      descriptor: connectorAction.descriptor,
    };
  }
  if (connectorAction.status === "invalid") {
    return {
      type: "unavailable-action",
      resourceKey: connectorAction.originalUrl,
      descriptor: { originalUrl: connectorAction.originalUrl },
    };
  }

  const connectorAccountAction = parseConnectorAccountActionUrl(
    url,
    chatActionContext,
  );
  if (connectorAccountAction.status === "valid") {
    return {
      type: "connector-account-action",
      resourceKey: connectorAccountActionResourceKey(
        connectorAccountAction.descriptor,
      ),
      descriptor: connectorAccountAction.descriptor,
    };
  }
  if (connectorAccountAction.status === "invalid") {
    return {
      type: "unavailable-action",
      resourceKey: connectorAccountAction.originalUrl,
      descriptor: { originalUrl: connectorAccountAction.originalUrl },
    };
  }

  const permissionAction = parsePermissionActionUrl(url, chatActionContext);
  if (permissionAction.status === "valid") {
    return {
      type: "permission-action",
      resourceKey: permissionActionResourceKey(permissionAction.descriptor),
      descriptor: permissionAction.descriptor,
    };
  }
  if (permissionAction.status === "invalid") {
    return {
      type: "unavailable-action",
      resourceKey: permissionAction.originalUrl,
      descriptor: { originalUrl: permissionAction.originalUrl },
    };
  }

  const bankingAction = parseBankingActionUrl(url, chatActionContext);
  if (bankingAction.status === "valid") {
    return {
      type: "banking-action",
      resourceKey: bankingActionResourceKey(bankingAction.descriptor),
      descriptor: bankingAction.descriptor,
    };
  }
  if (bankingAction.status === "invalid") {
    return {
      type: "unavailable-action",
      resourceKey: bankingAction.originalUrl,
      descriptor: { originalUrl: bankingAction.originalUrl },
    };
  }

  const computerUseAuthorization = parseComputerUseAuthorizationUrl(url);
  if (computerUseAuthorization) {
    return {
      type: "computer-use-authorization",
      resourceKey: computerUseAuthorization.href,
      descriptor: computerUseAuthorization,
    };
  }

  const planUpgrade = parsePlanUpgradeUrl(url);
  if (planUpgrade) {
    return {
      type: "plan-upgrade",
      resourceKey: planUpgrade.href,
      descriptor: planUpgrade,
    };
  }

  const mailDraft = parseMailDraftUrl(url);
  if (mailDraft) {
    return {
      type: "mail-draft",
      resourceKey: mailDraft.mailDraftId,
      descriptor: mailDraft,
    };
  }

  const browserSession = parseBrowserSessionUrl(url);
  if (
    browserSession &&
    browserSession.threadId === chatActionContext?.threadId
  ) {
    return {
      type: "browser-session",
      resourceKey: browserSession.href,
      descriptor: browserSession,
    };
  }

  return null;
}

function retainedActionMarkdown(
  line: string,
  originalUrl: string,
): string | null {
  const candidate = stripMarkdownLineDecorations(line);
  const standaloneMarkdownLink = candidate.match(
    new RegExp(String.raw`^\[([^\]]+)\]\((${URL_TOKEN_PATTERN})\)$`),
  );
  const standaloneBareUrl = candidate.match(
    new RegExp(`^(${URL_TOKEN_PATTERN})$`),
  );
  if (standaloneMarkdownLink || standaloneBareUrl) {
    return null;
  }

  return line.replace(
    new RegExp(String.raw`\[([^\]]+)\]\((${URL_TOKEN_PATTERN})\)`),
    (match: string, label: string, url: string) => {
      return trimPreviewUrl(url) === originalUrl ? label : match;
    },
  );
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return null;
  }

  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());

  if (cells[0] === "") {
    cells.shift();
  }
  if (cells.at(-1) === "") {
    cells.pop();
  }

  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return (
    cells !== null &&
    cells.every((cell) => {
      return /^:?-{3,}:?$/.test(cell.replace(/\s+/g, ""));
    })
  );
}

function isMarkdownTableContentRow(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return (
    cells !== null &&
    cells.some((cell) => {
      return cell.length > 0;
    })
  );
}

function markdownTableRowIndexes(lines: string[]): Set<number> {
  const indexes = new Set<number>();
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      isMarkdownTableContentRow(lines[index]!) &&
      isMarkdownTableSeparator(lines[index + 1]!)
    ) {
      indexes.add(index);
      indexes.add(index + 1);

      for (
        let rowIndex = index + 2;
        rowIndex < lines.length && isMarkdownTableContentRow(lines[rowIndex]!);
        rowIndex += 1
      ) {
        indexes.add(rowIndex);
      }
    }
  }
  return indexes;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function parseBodyBlocks(
  content: string,
  options: ParseBodyBlocksOptions = {},
): {
  cleanContent: string;
  blocks: ParsedBodyBlock[];
} {
  const previews = options.previews ?? true;
  const blocks: ParsedBodyBlock[] = [];
  const lines = content.split("\n");
  const tableRowIndexes = markdownTableRowIndexes(lines);
  const keptLines: string[] = [];
  const markdownBuffer: string[] = [];
  let blockSequence = 0;
  let openFence: OpenMarkdownFence | null = null;
  const nextMarkdownBlockId = () => {
    blockSequence += 1;
    return `markdown-${blockSequence}`;
  };

  const flushMarkdownBuffer = () => {
    const joined = markdownBuffer.join("\n").trim();
    if (joined) {
      blocks.push({
        type: "markdown",
        id: nextMarkdownBlockId(),
        content: joined,
      });
    }
    markdownBuffer.length = 0;
  };

  const pushMarkdownLines = (nextLines: readonly string[]) => {
    markdownBuffer.push(...nextLines);
    keptLines.push(...nextLines);
  };

  for (const [lineIndex, line] of lines.entries()) {
    const nextFence = nextMarkdownFence(line, openFence);
    if (openFence !== null || nextFence !== null) {
      openFence = nextFence;
      pushMarkdownLines([line]);
      continue;
    }

    if (tableRowIndexes.has(lineIndex)) {
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    const actionBlock = previews
      ? createActionBlockFromLine(line, options.chatActionContext)
      : null;
    if (actionBlock) {
      if (actionBlock.type === "connector-action") {
        const retainedMarkdown = retainedActionMarkdown(
          line,
          actionBlock.descriptor.originalUrl,
        );
        if (retainedMarkdown) {
          pushMarkdownLines([retainedMarkdown]);
        }
      }
      flushMarkdownBuffer();
      blocks.push(actionBlock);
      continue;
    }

    pushMarkdownLines([line]);
  }

  flushMarkdownBuffer();

  const cleanContent = keptLines.join("\n").trim();

  return {
    cleanContent,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Event body plan
// ---------------------------------------------------------------------------

export type CardDescriptorBlock = Exclude<ParsedBodyBlock, ParsedMarkdownBlock>;

/** The URL a card's slot stands on, and the key its signals are looked up by. */
export function cardSlotUrl(block: CardDescriptorBlock): string {
  switch (block.type) {
    case "connector-action": {
      return block.descriptor.originalUrl;
    }
    case "connector-account-action": {
      return block.descriptor.originalUrl;
    }
    case "permission-action": {
      return block.descriptor.originalUrl;
    }
    case "banking-action": {
      return block.descriptor.originalUrl;
    }
    case "unavailable-action": {
      return block.descriptor.originalUrl;
    }
    case "computer-use-authorization": {
      return block.descriptor.originalUrl;
    }
    case "plan-upgrade": {
      return block.descriptor.href;
    }
    case "mail-draft": {
      return block.descriptor.originalUrl;
    }
    case "browser-session": {
      return block.descriptor.href;
    }
  }
}

function cardSlotMarkdown(url: string): string {
  const label = url
    .replace(/\\/g, String.raw`\\`)
    .replace(/\]/g, String.raw`\]`);
  return `[${label}](<${url}>)`;
}

interface EventBodyPlan {
  /**
   * The event body as one markdown document. Where the scanner recognized a
   * card, the prose carries a link to the card's URL standing alone in a
   * paragraph; the tree pass swaps those paragraphs for the cards registered
   * under the same URL and leaves any it cannot resolve as ordinary links.
   */
  readonly treeSource: string;
  /** The recognized cards, in the order their slots appear in the source. */
  readonly descriptors: readonly CardDescriptorBlock[];
}

/**
 * Plans one event body. The line scanner in `parseBodyBlocks` stays the sole
 * authority on action-card slots. Artifact links and images stay in the
 * original Markdown; their resources are registered on the parsed nodes.
 */
export function eventBodyPlan(
  content: string,
  options: ParseBodyBlocksOptions = {},
): EventBodyPlan {
  const { blocks } = parseBodyBlocks(content, options);
  const descriptors: CardDescriptorBlock[] = [];
  const parts = blocks.map((block) => {
    if (block.type === "markdown") {
      return block.content;
    }
    descriptors.push(block);
    return cardSlotMarkdown(cardSlotUrl(block));
  });
  return { treeSource: parts.join("\n\n"), descriptors };
}
