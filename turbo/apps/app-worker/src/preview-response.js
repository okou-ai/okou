const PREVIEW_HOST =
  /^pr-[1-9][0-9]*-app-okou-app-preview\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/u;
const BUILD_META = "okou-app-git-commit-sha";

// This recognizes the generated head declaration, not arbitrary HTML recovery.
// Ambiguous syntax omits diagnostics instead of guessing a serving identity.
function metaAttributes(source) {
  const attributes = new Map();
  const pattern =
    /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/guy;
  let offset = 0;
  while (offset < source.length) {
    if (/^\s*\/?\s*$/u.test(source.slice(offset))) break;
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) return null;
    const name = match[1].toLowerCase();
    if (attributes.has(name)) return null;
    const quoted = match[2] ?? match[3];
    if ((name === "name" || name === "content") && quoted === undefined) {
      return null;
    }
    attributes.set(name, quoted ?? match[4] ?? "");
    offset = pattern.lastIndex;
  }
  return attributes;
}

function uniqueBuildSha(declarations) {
  return declarations.length === 1 && /^[0-9a-f]{40}$/u.test(declarations[0])
    ? declarations[0]
    : undefined;
}

export function previewBuildSha(indexHtml) {
  const tokens =
    /<!--[\s\S]*?(?:-->|$)|<!doctype\s+html\s*>|<\/?[a-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/giu;
  let inHead = false;
  let offset = 0;
  const declarations = [];
  for (
    let token = tokens.exec(indexHtml);
    token;
    token = tokens.exec(indexHtml)
  ) {
    if (indexHtml.slice(offset, token.index).trim()) return undefined;
    offset = tokens.lastIndex;
    const text = token[0];
    if (text.startsWith("<!")) continue;
    const tag = /^<(\/?[a-z][a-z0-9:-]*)/iu.exec(text)[1].toLowerCase();
    if (tag === "html" && !inHead) continue;
    if (tag === "head" && !inHead) {
      inHead = true;
      continue;
    }
    if (!inHead) return undefined;
    if (tag === "/head") {
      return uniqueBuildSha(declarations);
    }
    if (["script", "style", "title", "noscript"].includes(tag)) {
      const end = new RegExp(`</${tag}\\s*>`, "giu");
      end.lastIndex = offset;
      const closing = end.exec(indexHtml);
      if (!closing) return undefined;
      tokens.lastIndex = end.lastIndex;
      offset = end.lastIndex;
      continue;
    }
    if (tag === "meta") {
      const attributes = metaAttributes(text.slice(5, -1));
      if (!attributes || attributes.get("name")?.includes("&"))
        return undefined;
      if (attributes.get("name") === BUILD_META) {
        declarations.push(attributes.get("content"));
      }
    } else if (tag !== "link" && tag !== "base") {
      return undefined;
    }
  }
  return undefined;
}

function eligiblePreviewResponse(request, response) {
  const url = new URL(request.url);
  return (
    request.method === "GET" &&
    url.protocol === "https:" &&
    PREVIEW_HOST.test(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port &&
    url.pathname === "/sign-in" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document" &&
    response.status === 200 &&
    !response.redirected &&
    /^text\/html(?:\s*;|\s*$)/iu.test(
      response.headers.get("content-type") ?? "",
    ) &&
    (!response.url || new URL(response.url).origin === url.origin)
  );
}

export function withPreviewBuildIdentity(worker, indexHtml) {
  const sha = previewBuildSha(indexHtml);
  return {
    async fetch(request, env, context) {
      const response = await worker.fetch.call(worker, request, env, context);
      if (sha && eligiblePreviewResponse(request, response)) {
        response.headers.set("x-okou-preview-build-sha", sha);
      }
      return response;
    },
  };
}
