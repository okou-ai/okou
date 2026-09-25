import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [workerPath, indexPath, manifestPath, faviconPath] =
  process.argv.slice(2);
if (!workerPath || !indexPath || !manifestPath || !faviconPath) {
  throw new Error("worker, index, manifest, and favicon paths are required");
}

function faviconEntries(favicon) {
  assert.equal(favicon.readUInt16LE(0), 0);
  assert.equal(favicon.readUInt16LE(2), 1);
  const count = favicon.readUInt16LE(4);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const dataLength = favicon.readUInt32LE(entryOffset + 8);
    const dataOffset = favicon.readUInt32LE(entryOffset + 12);
    assert.ok(dataOffset >= 6 + count * 16);
    assert.ok(dataOffset + dataLength <= favicon.length);
    assert.equal(
      favicon.subarray(dataOffset, dataOffset + 8).toString("hex"),
      "89504e470d0a1a0a",
    );
    entries.push({
      bitDepth: favicon.readUInt16LE(entryOffset + 6),
      height: favicon[entryOffset + 1] || 256,
      width: favicon[entryOffset] || 256,
    });
  }
  return entries;
}

function parseAttributes(tag) {
  const attributes = new Map();
  const pattern = /([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*(["'])(.*?)\2/gu;
  for (const match of tag.matchAll(pattern)) {
    const name = match[1];
    const value = match[3];
    if (name !== undefined && value !== undefined) {
      attributes.set(name, value);
    }
  }
  return attributes;
}

function serializeAttributes(attributes) {
  return [...attributes].map(([name, value]) => ` ${name}="${value}"`).join("");
}

function matchesSelector(tagName, attributes, selector) {
  if (selector === tagName) {
    return true;
  }
  const match = /^(meta|link)\[(name|property|rel)(\^?=)"([^"]+)"\]$/u.exec(
    selector,
  );
  if (!match || match[1] !== tagName) {
    return false;
  }
  const attributeName = match[2];
  const operator = match[3];
  const expectedValue = match[4];
  const actualValue = attributes.get(attributeName);
  if (actualValue === undefined) {
    return false;
  }
  return operator === "^="
    ? actualValue.startsWith(expectedValue)
    : actualValue === expectedValue;
}

async function applyHandler({ attributes, handler, innerContent = "" }) {
  const state = {
    appendedContent: "",
    attributes,
    innerContent,
    mutated: false,
    prependedContent: "",
    removed: false,
  };
  await handler.element({
    append(content) {
      state.mutated = true;
      state.appendedContent += content;
    },
    getAttribute(name) {
      return state.attributes.get(name) ?? null;
    },
    remove() {
      state.mutated = true;
      state.removed = true;
    },
    prepend(content) {
      state.mutated = true;
      state.prependedContent = `${content}${state.prependedContent}`;
    },
    setAttribute(name, value) {
      state.mutated = true;
      state.attributes.set(name, value);
    },
    setInnerContent(content) {
      state.mutated = true;
      state.innerContent = content;
    },
  });
  return state;
}

async function rewritePairedTag(html, tagName, handler) {
  const pattern =
    tagName === "html"
      ? /<html([^>]*)>([\s\S]*?)<\/html>/iu
      : tagName === "head"
        ? /<head([^>]*)>([\s\S]*?)<\/head>/iu
        : tagName === "body"
          ? /<body([^>]*)>([\s\S]*?)<\/body>/iu
          : /<title([^>]*)>([\s\S]*?)<\/title>/iu;
  const match = pattern.exec(html);
  if (!match || match.index === undefined) {
    return html;
  }
  const attributeSource = match[1] ?? "";
  const innerContent = match[2] ?? "";
  const state = await applyHandler({
    attributes: parseAttributes(attributeSource),
    handler,
    innerContent,
  });
  if (!state.mutated) {
    return html;
  }
  const replacement = state.removed
    ? ""
    : `<${tagName}${serializeAttributes(state.attributes)}>${state.prependedContent}${state.innerContent}${state.appendedContent}</${tagName}>`;
  return `${html.slice(0, match.index)}${replacement}${html.slice(match.index + match[0].length)}`;
}

async function rewriteVoidTag(html, tagName, selector, handler) {
  const pattern =
    tagName === "meta"
      ? /<meta\b[^>]*>/giu
      : tagName === "link"
        ? /<link\b[^>]*>/giu
        : /<img\b[^>]*>/giu;
  let rewritten = "";
  let offset = 0;
  for (const match of html.matchAll(pattern)) {
    const tag = match[0];
    const index = match.index;
    const attributes = parseAttributes(tag);
    if (!matchesSelector(tagName, attributes, selector)) {
      continue;
    }
    const state = await applyHandler({ attributes, handler });
    rewritten += html.slice(offset, index);
    if (!state.mutated) {
      rewritten += tag;
    } else if (!state.removed) {
      rewritten += `<${tagName}${serializeAttributes(state.attributes)} />`;
    }
    offset = index + tag.length;
  }
  return offset === 0 ? html : `${rewritten}${html.slice(offset)}`;
}

async function rewriteElementById(html, id, handler) {
  const openingPattern = /<([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/giu;
  for (const openingMatch of html.matchAll(openingPattern)) {
    if (parseAttributes(openingMatch[0]).get("id") !== id) {
      continue;
    }
    const tagName = openingMatch[1];
    const openingIndex = openingMatch.index;
    if (!tagName || openingIndex === undefined) {
      return html;
    }
    const tagPattern = /<\/?([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/giu;
    tagPattern.lastIndex = openingIndex + openingMatch[0].length;
    let depth = 1;
    let closingMatch;
    for (const candidate of html.matchAll(tagPattern)) {
      if (candidate[1]?.toLowerCase() !== tagName.toLowerCase()) {
        continue;
      }
      if (candidate.index < tagPattern.lastIndex) {
        continue;
      }
      if (candidate[0].startsWith("</")) {
        depth -= 1;
      } else if (!candidate[0].endsWith("/>")) {
        depth += 1;
      }
      if (depth === 0) {
        closingMatch = candidate;
        break;
      }
    }
    if (!closingMatch || closingMatch.index === undefined) {
      return html;
    }
    const innerStart = openingIndex + openingMatch[0].length;
    const state = await applyHandler({
      attributes: parseAttributes(openingMatch[0]),
      handler,
      innerContent: html.slice(innerStart, closingMatch.index),
    });
    if (!state.mutated) {
      return html;
    }
    const replacement = state.removed
      ? ""
      : `<${tagName}${serializeAttributes(state.attributes)}>${state.prependedContent}${state.innerContent}${state.appendedContent}</${tagName}>`;
    return `${html.slice(0, openingIndex)}${replacement}${html.slice(closingMatch.index + closingMatch[0].length)}`;
  }
  return html;
}

async function rewriteHtml(html, selector, handler) {
  if (
    selector === "html" ||
    selector === "head" ||
    selector === "body" ||
    selector === "title"
  ) {
    return rewritePairedTag(html, selector, handler);
  }
  if (selector.startsWith("meta[")) {
    return rewriteVoidTag(html, "meta", selector, handler);
  }
  if (selector.startsWith("link[")) {
    return rewriteVoidTag(html, "link", selector, handler);
  }
  if (selector === "img") {
    return rewriteVoidTag(html, "img", selector, handler);
  }
  if (selector.startsWith("#")) {
    return rewriteElementById(html, selector.slice(1), handler);
  }
  throw new Error(`Unsupported test HTMLRewriter selector: ${selector}`);
}

globalThis.HTMLRewriter = class HTMLRewriter {
  handlers = [];

  on(selector, handler) {
    this.handlers.push({ handler, selector });
    return this;
  }

  transform(response) {
    const handlers = this.handlers;
    const body = new ReadableStream({
      async start(controller) {
        let html = await response.text();
        for (const { handler, selector } of handlers) {
          html = await rewriteHtml(html, selector, handler);
        }
        const marker = "<!--okou-app-api-prefetch-->";
        const markerIndex = html.indexOf(marker);
        const encoder = new TextEncoder();
        if (markerIndex === -1) {
          controller.enqueue(encoder.encode(html));
        } else {
          const splitIndex = markerIndex + Math.floor(marker.length / 2);
          controller.enqueue(encoder.encode(html.slice(0, splitIndex)));
          controller.enqueue(encoder.encode(html.slice(splitIndex)));
        }
        controller.close();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
};

const [indexTemplate, manifestTemplate, favicon, workerModule] =
  await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(faviconPath),
    import(pathToFileURL(workerPath).href),
  ]);
assert.deepEqual(faviconEntries(favicon), [
  { bitDepth: 32, height: 16, width: 16 },
  { bitDepth: 32, height: 32, width: 32 },
  { bitDepth: 32, height: 48, width: 48 },
  { bitDepth: 32, height: 256, width: 256 },
]);
const sharedThreadId = "10000000-0000-4000-8000-000000000001";
const previewOrigin = "https://pr-25304-api.vm6.ai";
const clerkJsVersion = "6.25.8";
const previewClerkHost = "informed-calf-6.clerk.accounts.dev";
const productionClerkHost = "clerk.okou.ai";
const previewClerkPublishableKey = publishableKey("test", previewClerkHost);
const productionClerkPublishableKey = publishableKey(
  "live",
  productionClerkHost,
);
const clerkUiVersion = "1.26.0";
const clerkBrowserScriptUrl = `https://cdn.jsdelivr.net/npm/@clerk/clerk-js@${clerkJsVersion}/dist/clerk.browser.js`;
const clerkUiScriptUrl = `https://cdn.jsdelivr.net/npm/@clerk/ui@${clerkUiVersion}/dist/ui.browser.js`;
const builtIndexTemplate = indexTemplate
  .replaceAll(
    "%VITE_CLERK_PUBLISHABLE_KEY_PREVIEW%",
    previewClerkPublishableKey,
  )
  .replaceAll(
    "%VITE_CLERK_PUBLISHABLE_KEY_PROD%",
    productionClerkPublishableKey,
  )
  .replaceAll("__OKOU_CLERK_BROWSER_SCRIPT_URL__", clerkBrowserScriptUrl)
  .replaceAll("__OKOU_CLERK_UI_SCRIPT_URL__", clerkUiScriptUrl);
const embeddedIndexTemplate = builtIndexTemplate
  .replace(
    "</head>",
    [
      '<link id="okou-main-stylesheet" rel="preload" as="style" href="https://static.okou.io/okou-app/assets/index-Test1234.css" />',
      '<link rel="modulepreload" href="https://static.okou.io/okou-app/assets/vendor-Test1234.js" />',
      "</head>",
    ].join("\n"),
  )
  .replace(
    "</body>",
    '<script type="module" src="https://static.okou.io/okou-app/assets/index-Test1234.js"></script>\n</body>',
  );
const embeddedShell = {
  favicon: favicon.buffer.slice(
    favicon.byteOffset,
    favicon.byteOffset + favicon.byteLength,
  ),
  icon192: new TextEncoder().encode("icon-192").buffer,
  icon512: new TextEncoder().encode("icon-512").buffer,
  icon512Maskable: new TextEncoder().encode("icon-maskable").buffer,
  indexHtml: embeddedIndexTemplate,
  manifest: manifestTemplate,
  robots: "User-agent: *\nAllow: /\n",
  serviceWorker: 'self.addEventListener("install", () => {});',
};
const embeddedWorker = workerModule.createWorker(embeddedShell);
const worker = embeddedWorker;
const expectedClerkCoreScript = clerkCoreScript(builtIndexTemplate);
const expectedClerkBootstrap = clerkBootstrap(builtIndexTemplate);
const okouTitle = "AI Teammate for Real Work — More Done, Same Team | Okou";
const okouDescription =
  "An AI teammate that connects to 3,000+ tools: get the right data, run agentic workflows, and deliver finished work with team-wide context.";

function publishableKey(environment, host) {
  return `pk_${environment}_${Buffer.from(`${host}$`).toString("base64")}`;
}

function assetEnvironment() {
  return {
    STATIC_ASSETS_BUCKET: {
      get(key, options) {
        observedR2Key = key;
        observedR2Options = options;
        const body = "export const worker = true;";
        const bodySize = new TextEncoder().encode(body).byteLength;
        const range = options?.range.get("Range")
          ? { offset: 0, length: bodySize }
          : undefined;
        return Promise.resolve({
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          }),
          httpEtag: '"shared-worker-etag"',
          range,
          size: bodySize,
          writeHttpMetadata(headers) {
            headers.set("Content-Type", "application/javascript");
          },
        });
      },
    },
  };
}

function tagAttribute(html, tagName, selectorAttribute, selectorValue, target) {
  const pattern =
    tagName === "meta"
      ? /<meta\b[^>]*>/giu
      : tagName === "link"
        ? /<link\b[^>]*>/giu
        : /<img\b[^>]*>/giu;
  for (const match of html.matchAll(pattern)) {
    const attributes = parseAttributes(match[0]);
    if (attributes.get(selectorAttribute) === selectorValue) {
      return attributes.get(target) ?? null;
    }
  }
  return null;
}

function tagAttributeValues(html, tagName, target) {
  const pattern = tagName === "link" ? /<link\b[^>]*>/giu : /<img\b[^>]*>/giu;
  return [...html.matchAll(pattern)].flatMap((match) => {
    const value = parseAttributes(match[0]).get(target);
    return value === undefined ? [] : [value];
  });
}

function metaContent(html, selectorAttribute, selectorValue) {
  return tagAttribute(
    html,
    "meta",
    selectorAttribute,
    selectorValue,
    "content",
  );
}

function documentTitle(html) {
  return /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]?.trim() ?? null;
}

function htmlAttribute(html, attributeName) {
  const tag = /<html\b[^>]*>/iu.exec(html)?.[0];
  return tag ? (parseAttributes(tag).get(attributeName) ?? null) : null;
}

function clerkEdgeSessionJson(html) {
  const matches = [
    ...html.matchAll(
      /<script type="application\/json" id="okou-clerk-edge-session">([\s\S]*?)<\/script>/giu,
    ),
  ];
  assert.equal(matches.length, 1);
  return JSON.parse(matches[0][1]);
}

const SHARED_DATABASE_WORKER_PRELOAD_PATTERN =
  /<script>window\.__okouSharedDatabaseWorkerBootstrap\.start\(([\s\S]*?)\);<\/script>/u;

function sharedDatabaseWorkerPreloadArguments(html) {
  const matches = [
    ...html.matchAll(
      new RegExp(SHARED_DATABASE_WORKER_PRELOAD_PATTERN.source, "gu"),
    ),
  ];
  assert.equal(matches.length, 1);
  return JSON.parse(`[${matches[0][1]}]`);
}

function prefetchedApiJson(html, path) {
  for (const match of html.matchAll(
    /<script\b[^>]*data-okou-api-bootstrap=""[^>]*>([\s\S]*?)<\/script>/giu,
  )) {
    const attributes = parseAttributes(match[0]);
    if (attributes.get("data-path") === encodeURIComponent(path)) {
      return JSON.parse(match[1]);
    }
  }
  throw new Error(`Prefetched API script is unavailable for ${path}`);
}

function prefetchedApiPaths(html) {
  return [
    ...html.matchAll(/<script\b[^>]*data-okou-api-bootstrap=""[^>]*>/giu),
  ].map((match) => {
    const path = parseAttributes(match[0]).get("data-path");
    if (path === undefined) {
      throw new Error("Prefetched API script path is unavailable");
    }
    return decodeURIComponent(path);
  });
}

async function responseSnapshot(targetWorker, url, env) {
  const response = await targetWorker.fetch(
    new Request(url, {
      headers: {
        Cookie:
          "__session=jwt-cookie-must-not-render; __clerk_db_jwt=dev-browser-jwt-must-not-render",
      },
    }),
    env,
  );
  return {
    body: await response.text(),
    headers: [...response.headers.entries()],
    status: response.status,
    statusText: response.statusText,
  };
}

function assertNoClerkSecrets(snapshot) {
  for (const sensitiveValue of [
    "jwt-cookie-must-not-render",
    "dev-browser-jwt-must-not-render",
    "sk_test_secret-must-not-render",
    "sk_live_secret-must-not-render",
    "session-token-must-not-render",
    "claim-must-not-render",
    "handshake-cookie-must-not-render",
    "refreshed-cookie-must-not-render",
    "token=must-not-render",
  ]) {
    assert.doesNotMatch(snapshot.body, new RegExp(sensitiveValue, "u"));
  }
}

function clerkBootstrap(html) {
  const bootstrap =
    /<script\b[^>]*data-okou-clerk-bootstrap=""[^>]*>[\s\S]*?<\/script>/iu.exec(
      html,
    )?.[0];
  if (!bootstrap) {
    throw new Error("Clerk bootstrap script is unavailable");
  }
  return bootstrap;
}

function clerkCoreScript(html) {
  const script =
    /<script\b[^>]*id="okou-clerk-core-script"[^>]*><\/script>/iu.exec(
      html,
    )?.[0];
  if (!script) {
    throw new Error("Clerk core script is unavailable");
  }
  return script;
}

function assertBootstrapWordmark(html) {
  assert.match(
    html,
    /--app-skeleton-wordmark:\s*url\("\.\/scripts\/app-skeleton-assets\/wordmark-sprite\.webp\?inline"\)/u,
  );
  assert.match(
    html,
    /<div\b[^>]*class="app-bootstrap-skeleton__wordmark"[^>]*aria-hidden="true"[^>]*>/iu,
  );
  assert.equal(
    [...html.matchAll(/class="app-bootstrap-skeleton__letter"/gu)].length,
    4,
  );
  assert.equal(
    [...html.matchAll(/class="app-bootstrap-skeleton__glyph"/gu)].length,
    4,
  );
  assert.doesNotMatch(html, /app-bootstrap-skeleton__avatar/u);
  assert.doesNotMatch(html, /assets\/avatar-svg\//u);
}

async function requestAppPage(origin) {
  const response = await worker.fetch(
    new Request(`${origin}/settings/profile`),
    assetEnvironment(),
  );
  const html = await response.text();
  return { html, response };
}

const posthogMetadataUrl =
  "https://app.okou.ai/connectors/posthog/metadata.json";
const posthogMetadataResponse = await worker.fetch(
  new Request(posthogMetadataUrl),
  {},
);
assert.equal(posthogMetadataResponse.status, 200);
assert.equal(
  posthogMetadataResponse.headers.get("content-type"),
  "application/json; charset=UTF-8",
);
assert.equal(
  posthogMetadataResponse.headers.get("cache-control"),
  "public, max-age=300",
);
assert.equal(posthogMetadataResponse.headers.get("set-cookie"), null);
assert.equal(
  posthogMetadataResponse.headers.get("x-content-type-options"),
  "nosniff",
);
const posthogMetadata = await posthogMetadataResponse.json();
assert.equal(posthogMetadata.client_id, posthogMetadataUrl);
assert.deepEqual(posthogMetadata.redirect_uris, [
  "https://app.okou.ai/connectors/posthog/callback",
]);
assert.equal(posthogMetadata.token_endpoint_auth_method, "none");

const posthogMetadataHead = await worker.fetch(
  new Request(posthogMetadataUrl, { method: "HEAD" }),
  {},
);
assert.equal(posthogMetadataHead.status, 200);
assert.deepEqual(
  [...posthogMetadataHead.headers],
  [...posthogMetadataResponse.headers],
);
assert.equal(await posthogMetadataHead.text(), "");

const posthogMetadataPost = await worker.fetch(
  new Request(posthogMetadataUrl, { method: "POST" }),
  {},
);
assert.equal(posthogMetadataPost.status, 405);
assert.equal(posthogMetadataPost.headers.get("allow"), "GET, HEAD");

const posthogCallbackResponse = await worker.fetch(
  new Request("https://app.okou.ai/connectors/posthog/callback?code=test"),
  {},
);
assert.equal(posthogCallbackResponse.status, 200);
assert.equal(
  posthogCallbackResponse.headers.get("content-type"),
  "text/html; charset=UTF-8",
);
assert.equal(documentTitle(await posthogCallbackResponse.text()), okouTitle);

const okouPage = await requestAppPage("https://app.okou.ai");
assert.equal(okouPage.response.status, 200);
assert.equal(
  okouPage.response.headers.get("x-robots-tag"),
  "noindex, nofollow",
);
assert.equal(okouPage.response.headers.get("content-encoding"), null);
assert.equal(okouPage.response.headers.get("etag"), null);
assert.equal(okouPage.response.headers.get("x-frame-options"), "DENY");
assert.equal(
  okouPage.response.headers.get("permissions-policy"),
  "camera=(), geolocation=(), payment=(), usb=(), serial=(), display-capture=(self), clipboard-read=(), microphone=(self), bluetooth=(self), clipboard-write=(self), fullscreen=(self)",
);
assert.equal(documentTitle(okouPage.html), okouTitle);
assert.equal(htmlAttribute(okouPage.html, "data-app-brand-name"), "Okou");
assert.equal(metaContent(okouPage.html, "name", "application-name"), "Okou");
assert.equal(
  metaContent(okouPage.html, "name", "description"),
  okouDescription,
);
assert.equal(metaContent(okouPage.html, "property", "og:site_name"), "Okou");
assert.equal(metaContent(okouPage.html, "property", "og:title"), okouTitle);
assert.equal(
  metaContent(okouPage.html, "property", "og:description"),
  okouDescription,
);
assert.equal(metaContent(okouPage.html, "property", "og:image:alt"), okouTitle);
assert.equal(
  metaContent(okouPage.html, "property", "og:image"),
  "https://static.okou.io/web/okou-og-image-373c892e.png",
);
assert.equal(metaContent(okouPage.html, "name", "twitter:title"), okouTitle);
assert.equal(
  metaContent(okouPage.html, "name", "twitter:description"),
  okouDescription,
);
assert.equal(
  metaContent(okouPage.html, "name", "twitter:image"),
  "https://static.okou.io/web/okou-og-image-373c892e.png",
);
assert.equal(
  tagAttribute(okouPage.html, "link", "rel", "canonical", "href"),
  "https://app.okou.ai/",
);
assert.ok(
  tagAttributeValues(okouPage.html, "link", "href").includes(
    "https://static.okou.io/public/okou-favicon-adaptive-b4eda9221bb7.svg",
  ),
);
assert.equal(
  tagAttribute(okouPage.html, "link", "rel", "apple-touch-icon", "href"),
  "https://static.okou.io/platform/okou-pwa-be0be646-180.png",
);
assert.equal(
  tagAttributeValues(okouPage.html, "link", "href").some(
    (href) => href === "https://static.okou.io",
  ),
  false,
);
assertBootstrapWordmark(okouPage.html);
assert.equal(clerkCoreScript(okouPage.html), expectedClerkCoreScript);
assert.equal(clerkBootstrap(okouPage.html), expectedClerkBootstrap);

const okouPreview = await requestAppPage(
  "https://pr-25304-app-okou-app-preview.vm0.workers.dev",
);
assert.equal(htmlAttribute(okouPreview.html, "data-app-brand-name"), "Okou");
assert.equal(
  tagAttribute(okouPreview.html, "link", "rel", "canonical", "href"),
  "https://app.okou.ai/",
);
assert.equal(clerkBootstrap(okouPreview.html), expectedClerkBootstrap);
assert.equal(clerkCoreScript(okouPreview.html), expectedClerkCoreScript);
// Hosted Clerk UI is pinned with the core release set; the page must carry
// exactly that URL and never an unsubstituted marker.
assert.equal(okouPreview.html.includes(clerkUiScriptUrl), true);
assert.equal(okouPreview.html.includes("__OKOU_CLERK_UI_SCRIPT_URL__"), false);

const serviceWorker = await worker.fetch(
  new Request("https://pr-25304-app-okou-app-preview.vm0.workers.dev/sw.js"),
  assetEnvironment(),
);
assert.equal(
  serviceWorker.headers.get("cache-control"),
  "public, max-age=0, must-revalidate",
);
assert.equal(serviceWorker.headers.get("service-worker-allowed"), "/");
assert.equal(serviceWorker.headers.get("x-content-type-options"), "nosniff");

const embeddedPage = await embeddedWorker.fetch(
  new Request(
    "https://pr-25304-app-okou-app-preview.vm0.workers.dev/settings/profile",
  ),
  {},
);
const embeddedHtml = await embeddedPage.text();
assert.equal(embeddedPage.status, 200);
assert.equal(htmlAttribute(embeddedHtml, "data-app-brand-name"), "Okou");
assert.match(
  embeddedHtml,
  /https:\/\/pr-25304-app-okou-app-preview\.vm0\.workers\.dev\/okou-app\/assets\/index-Test1234\.js/u,
);
assert.match(
  embeddedHtml,
  /https:\/\/pr-25304-app-okou-app-preview\.vm0\.workers\.dev\/okou-app\/assets\/index-Test1234\.css/u,
);
assert.match(
  embeddedHtml,
  /https:\/\/pr-25304-app-okou-app-preview\.vm0\.workers\.dev\/okou-app\/assets\/vendor-Test1234\.js/u,
);
assert.doesNotMatch(
  embeddedHtml,
  /https:\/\/static\.okou\.io\/okou-app\/assets\//u,
);

const embeddedProductionPage = await embeddedWorker.fetch(
  new Request("https://app.okou.ai/settings/profile"),
  {},
);
const embeddedProductionHtml = await embeddedProductionPage.text();
assert.match(
  embeddedProductionHtml,
  /https:\/\/static\.okou\.io\/okou-app\/assets\/index-Test1234\.js/u,
);
assert.doesNotMatch(
  embeddedProductionHtml,
  /https:\/\/app\.okou\.ai\/okou-app\/assets\/index-Test1234\.js/u,
);

const edgePreviewOrigin =
  "https://pr-25304-app-okou-app-preview.vm0.workers.dev";
const edgePreviewUrl = `${edgePreviewOrigin}/settings/profile`;
const edgePreviewEnvironment = {
  CLERK_EDGE_AUTHORIZED_PARTY: edgePreviewOrigin,
  CLERK_PUBLISHABLE_KEY: previewClerkPublishableKey,
  CLERK_SECRET_KEY: "sk_test_secret-must-not-render",
};
let failingClerkClientFactoryCalls = 0;
const failingClerkClientFactory = () => {
  failingClerkClientFactoryCalls += 1;
  throw new Error("Clerk client factory failure");
};
const guardedEdgeWorker = workerModule.createWorker(
  embeddedShell,
  failingClerkClientFactory,
);
const edgePreviewBaseline = await responseSnapshot(
  guardedEdgeWorker,
  edgePreviewUrl,
  edgePreviewEnvironment,
);
assert.doesNotMatch(edgePreviewBaseline.body, /okou-clerk-edge-session/u);
assert.doesNotMatch(
  edgePreviewBaseline.body,
  SHARED_DATABASE_WORKER_PRELOAD_PATTERN,
);
assertNoClerkSecrets(edgePreviewBaseline);
assert.equal(failingClerkClientFactoryCalls, 1);

for (const ineligibleOrigin of [
  "http://app.okou.ai",
  "https://app.okou.ai.evil.example",
  "https://pr-25304-app.omby.ai",
  "https://staging-app-okou-app-preview.vm0.workers.dev",
]) {
  const ineligibleUrl = `${ineligibleOrigin}/settings/profile`;
  const ineligibleEnvironment = {
    ...edgePreviewEnvironment,
    CLERK_EDGE_AUTHORIZED_PARTY: ineligibleOrigin,
  };
  const baseline = await responseSnapshot(
    guardedEdgeWorker,
    ineligibleUrl,
    ineligibleEnvironment,
  );
  assert.doesNotMatch(baseline.body, /okou-clerk-edge-session/u);
  assertNoClerkSecrets(baseline);
}
assert.equal(failingClerkClientFactoryCalls, 1);

const missingConfig = await responseSnapshot(
  guardedEdgeWorker,
  edgePreviewUrl,
  {
    CLERK_EDGE_AUTHORIZED_PARTY: edgePreviewOrigin,
  },
);
assert.equal(missingConfig.body, edgePreviewBaseline.body);
assert.equal(missingConfig.status, edgePreviewBaseline.status);
assert.equal(
  new Headers(missingConfig.headers).get("Cache-Control"),
  "private, no-store",
);
assert.equal(failingClerkClientFactoryCalls, 1);

function clerkClientReturning(requestState) {
  return () => ({
    authenticateRequest() {
      return Promise.resolve(requestState);
    },
  });
}

const anonymous = await responseSnapshot(
  workerModule.createWorker(
    embeddedShell,
    clerkClientReturning({
      headers: new Headers(),
      isAuthenticated: false,
    }),
  ),
  edgePreviewUrl,
  edgePreviewEnvironment,
);

const handshake = await responseSnapshot(
  workerModule.createWorker(
    embeddedShell,
    clerkClientReturning({
      headers: new Headers({
        Location: "https://clerk.example/handshake?token=must-not-render",
        "Set-Cookie": "__session=handshake-cookie-must-not-render",
      }),
      isAuthenticated: false,
    }),
  ),
  edgePreviewUrl,
  edgePreviewEnvironment,
);

const refresh = await responseSnapshot(
  workerModule.createWorker(
    embeddedShell,
    clerkClientReturning({
      headers: new Headers({
        "Set-Cookie": "__session=refreshed-cookie-must-not-render",
      }),
      isAuthenticated: true,
      toAuth() {
        throw new Error("Refresh state must not be consumed");
      },
    }),
  ),
  edgePreviewUrl,
  edgePreviewEnvironment,
);

const thrown = await responseSnapshot(
  workerModule.createWorker(embeddedShell, () => ({
    authenticateRequest() {
      return Promise.reject(new Error("Clerk network failure"));
    },
  })),
  edgePreviewUrl,
  edgePreviewEnvironment,
);

const constructorThrown = await responseSnapshot(
  workerModule.createWorker(embeddedShell, () => {
    throw new Error("Clerk SDK failure");
  }),
  edgePreviewUrl,
  edgePreviewEnvironment,
);

const timedOut = await responseSnapshot(
  workerModule.createWorker(embeddedShell, () => ({
    authenticateRequest() {
      return new Promise(() => {});
    },
  })),
  edgePreviewUrl,
  edgePreviewEnvironment,
);

for (const unchanged of [
  anonymous,
  handshake,
  refresh,
  thrown,
  constructorThrown,
  timedOut,
]) {
  assert.equal(unchanged.body, edgePreviewBaseline.body);
  assert.equal(unchanged.status, edgePreviewBaseline.status);
  assert.equal(
    new Headers(unchanged.headers).get("Cache-Control"),
    "private, no-store",
  );
  assertNoClerkSecrets(unchanged);
  assert.equal(new Headers(unchanged.headers).get("Location"), null);
  assert.equal(new Headers(unchanged.headers).get("Set-Cookie"), null);
}

const currentUserId = "user_current</script><script>alert(1)</script>";
const escapedScript = currentUserId.slice("user_current".length);
const currentSessionId = "sess_current";
const failedApiFetcher = () => {
  return Promise.resolve(new Response(null, { status: 402 }));
};
const authenticatedWorker = workerModule.createWorker(
  embeddedShell,
  ({ publishableKey, secretKey, telemetry }) => {
    if (
      publishableKey !== previewClerkPublishableKey ||
      secretKey !== "sk_test_secret-must-not-render" ||
      telemetry?.disabled !== true
    ) {
      throw new Error("Unexpected Clerk client configuration");
    }
    return {
      authenticateRequest(request, options) {
        if (
          request.url !== edgePreviewUrl ||
          options.acceptsToken !== "session_token" ||
          options.authorizedParties.length !== 1 ||
          options.authorizedParties[0] !== edgePreviewOrigin
        ) {
          return Promise.reject(new Error("Unexpected Clerk request options"));
        }
        return Promise.resolve({
          headers: new Headers(),
          isAuthenticated: true,
          token: "session-token-must-not-render",
          toAuth() {
            return {
              orgId: "org_current",
              sessionClaims: { private: "claim-must-not-render" },
              sessionId: currentSessionId,
              userId: currentUserId,
            };
          },
        });
      },
    };
  },
  failedApiFetcher,
);
const authenticated = await responseSnapshot(
  authenticatedWorker,
  edgePreviewUrl,
  edgePreviewEnvironment,
);
assert.equal(authenticated.status, 200);
assert.equal(
  new Headers(authenticated.headers).get("Cache-Control"),
  "private, no-store",
);
assert.equal(new Headers(authenticated.headers).get("Location"), null);
assert.equal(new Headers(authenticated.headers).get("Set-Cookie"), null);
assert.match(authenticated.body, /id="app-bootstrap-skeleton"/u);
assert.match(authenticated.body, /\\u003c\/script>/u);
assert.doesNotMatch(authenticated.body, /<script>alert\(1\)<\/script>/u);
assert.deepEqual(clerkEdgeSessionJson(authenticated.body), {
  userId: currentUserId,
  sessionId: currentSessionId,
});
assert.deepEqual(Object.keys(clerkEdgeSessionJson(authenticated.body)).sort(), [
  "sessionId",
  "userId",
]);
assert.deepEqual(sharedDatabaseWorkerPreloadArguments(authenticated.body), [
  currentUserId,
  "org_current",
]);
assertNoClerkSecrets(authenticated);

const productionOrigin = "https://app.okou.ai";
const productionEdgeUrl = `${productionOrigin}/settings/profile`;
const productionEdgeEnvironment = {
  CLERK_PUBLISHABLE_KEY: productionClerkPublishableKey,
  CLERK_SECRET_KEY: "sk_live_secret-must-not-render",
};
let clerkClientFactoryCalls = 0;
const productionEdgeWorker = workerModule.createWorker(
  embeddedShell,
  ({ publishableKey, secretKey, telemetry }) => {
    clerkClientFactoryCalls += 1;
    assert.equal(publishableKey, productionClerkPublishableKey);
    assert.equal(secretKey, "sk_live_secret-must-not-render");
    assert.equal(telemetry?.disabled, true);
    return {
      authenticateRequest(request, options) {
        assert.equal(request.url, productionEdgeUrl);
        assert.equal(options.acceptsToken, "session_token");
        assert.deepEqual(options.authorizedParties, [productionOrigin]);
        return Promise.resolve({
          headers: new Headers(),
          isAuthenticated: true,
          toAuth() {
            return {
              orgId: "org_production",
              sessionId: "sess_production",
              userId: "user_production",
            };
          },
        });
      },
    };
  },
  failedApiFetcher,
);
const productionAuthenticated = await responseSnapshot(
  productionEdgeWorker,
  productionEdgeUrl,
  productionEdgeEnvironment,
);
assert.equal(clerkClientFactoryCalls, 1);
assert.deepEqual(clerkEdgeSessionJson(productionAuthenticated.body), {
  userId: "user_production",
  sessionId: "sess_production",
});
assert.equal(
  new Headers(productionAuthenticated.headers).get("Cache-Control"),
  "private, no-store",
);
assertNoClerkSecrets(productionAuthenticated);

const authenticatedWithoutSession = await responseSnapshot(
  workerModule.createWorker(
    embeddedShell,
    clerkClientReturning({
      headers: new Headers(),
      isAuthenticated: true,
      toAuth() {
        return { userId: "user_without_session", sessionId: null };
      },
    }),
    failedApiFetcher,
  ),
  edgePreviewUrl,
  edgePreviewEnvironment,
);
assert.doesNotMatch(
  authenticatedWithoutSession.body,
  /okou-clerk-edge-session/u,
);
assert.equal(
  new Headers(authenticatedWithoutSession.headers).get("Cache-Control"),
  "private, no-store",
);
assertNoClerkSecrets(authenticatedWithoutSession);

let apiFetchCallsWithoutOrganization = 0;
const authenticatedWithoutOrganization = await responseSnapshot(
  workerModule.createWorker(
    embeddedShell,
    clerkClientReturning({
      headers: new Headers(),
      isAuthenticated: true,
      toAuth() {
        return {
          userId: "user_without_organization",
          sessionId: "sess_without_organization",
          orgId: null,
        };
      },
    }),
    () => {
      apiFetchCallsWithoutOrganization += 1;
      return Promise.resolve(Response.json({}));
    },
  ),
  edgePreviewUrl,
  edgePreviewEnvironment,
);
assert.deepEqual(clerkEdgeSessionJson(authenticatedWithoutOrganization.body), {
  userId: "user_without_organization",
  sessionId: "sess_without_organization",
});
assert.equal(apiFetchCallsWithoutOrganization, 0);
assert.doesNotMatch(
  authenticatedWithoutOrganization.body,
  SHARED_DATABASE_WORKER_PRELOAD_PATTERN,
);
assertNoClerkSecrets(authenticatedWithoutOrganization);

const prefetchPagePath =
  "/settings/profile?x-vercel-protection-bypass=query-secret&keep=value";
const agentBody = Promise.withResolvers();
const featureSwitchesBody = Promise.withResolvers();
const observedApiRequests = [];
const apiRequestsStarted = Promise.withResolvers();
const prefetchWorker = workerModule.createWorker(
  embeddedShell,
  clerkClientReturning({
    headers: new Headers(),
    isAuthenticated: true,
    toAuth() {
      return {
        userId: "user_prefetch",
        sessionId: "sess_prefetch",
        orgId: "org_prefetch",
      };
    },
  }),
  (input, init) => {
    const url = new URL(input);
    observedApiRequests.push({
      headers: new Headers(init?.headers),
      method: init?.method,
      url,
    });
    if (observedApiRequests.length === 7) {
      apiRequestsStarted.resolve();
    }
    if (url.pathname === "/api/agents") {
      return {
        ok: true,
        json() {
          return agentBody.promise;
        },
      };
    }
    if (url.pathname === "/api/feature-switches") {
      return {
        ok: true,
        json() {
          return featureSwitchesBody.promise;
        },
      };
    }
    return new Response(null, { status: 402 });
  },
);
const prefetchedResponse = await prefetchWorker.fetch(
  new Request(`${edgePreviewOrigin}${prefetchPagePath}`, {
    headers: {
      Cookie:
        "__session=jwt-cookie-must-not-render; __clerk_db_jwt=dev-browser-jwt-must-not-render",
    },
  }),
  edgePreviewEnvironment,
);
await apiRequestsStarted.promise;
assert.deepEqual(observedApiRequests.map(({ url }) => url.pathname).sort(), [
  "/api/agents",
  "/api/feature-switches",
  "/api/model-policies",
  "/api/onboarding/status",
  "/api/org",
  "/api/user-model-preference",
  "/api/user-preferences",
]);
for (const { headers, method, url } of observedApiRequests) {
  assert.equal(url.origin, previewOrigin);
  assert.equal(url.search, "");
  assert.equal(method, "GET");
  assert.equal(headers.get("Origin"), edgePreviewOrigin);
  assert.equal(
    headers.get("Cookie"),
    "__session=jwt-cookie-must-not-render; __clerk_db_jwt=dev-browser-jwt-must-not-render",
  );
  assert.equal(headers.get("x-vercel-protection-bypass"), "query-secret");
}
const prefetchedReader = prefetchedResponse.body.getReader();
const prefetchedDecoder = new TextDecoder();
const firstPrefixChunk = await prefetchedReader.read();
assert.equal(firstPrefixChunk.done, false);
const secondPrefixChunk = await prefetchedReader.read();
assert.equal(secondPrefixChunk.done, false);
const prefixHtml =
  prefetchedDecoder.decode(firstPrefixChunk.value, { stream: true }) +
  prefetchedDecoder.decode(secondPrefixChunk.value, { stream: true });
assert.match(prefixHtml, /id="root"/u);
assert.match(prefixHtml, /id="app-bootstrap-skeleton"/u);
assert.doesNotMatch(prefixHtml, /data-okou-api-bootstrap/u);
// The Worker preload must not wait for the API prefetch budget.
// The page adds its URL bypass to the Worker URL, so the edge forwards it.
assert.deepEqual(sharedDatabaseWorkerPreloadArguments(prefixHtml), [
  "user_prefetch",
  "org_prefetch",
  "query-secret",
]);
assert.doesNotMatch(prefixHtml, /<\/body>/u);

agentBody.resolve([{ agentId: "agent-prefetched" }]);
const agentChunk = await prefetchedReader.read();
assert.equal(agentChunk.done, false);
const agentHtml = prefetchedDecoder.decode(agentChunk.value, { stream: true });
assert.deepEqual(prefetchedApiPaths(agentHtml), ["/api/agents"]);
assert.deepEqual(prefetchedApiJson(agentHtml, "/api/agents"), [
  { agentId: "agent-prefetched" },
]);
assert.doesNotMatch(agentHtml, /api%2Ffeature-switches/u);

featureSwitchesBody.resolve({
  switches: { escaped: escapedScript },
  effectiveSwitches: {},
});
const featureSwitchesChunk = await prefetchedReader.read();
assert.equal(featureSwitchesChunk.done, false);
const featureSwitchesHtml = prefetchedDecoder.decode(
  featureSwitchesChunk.value,
  { stream: true },
);
assert.deepEqual(prefetchedApiPaths(featureSwitchesHtml), [
  "/api/feature-switches",
]);
assert.deepEqual(
  prefetchedApiJson(featureSwitchesHtml, "/api/feature-switches"),
  {
    switches: { escaped: escapedScript },
    effectiveSwitches: {},
  },
);

let suffixHtml = "";
while (true) {
  const suffixChunk = await prefetchedReader.read();
  if (suffixChunk.done) {
    break;
  }
  suffixHtml += prefetchedDecoder.decode(suffixChunk.value, { stream: true });
}
suffixHtml += prefetchedDecoder.decode();
const prefetchedHtml = `${prefixHtml}${agentHtml}${featureSwitchesHtml}${suffixHtml}`;
assert.match(suffixHtml, /<\/body>/u);
assert.deepEqual(prefetchedApiPaths(prefetchedHtml), [
  "/api/agents",
  "/api/feature-switches",
]);
assert.doesNotMatch(prefetchedHtml, /api%2Fuser-preferences/u);
assert.doesNotMatch(prefetchedHtml, /<script>alert\(1\)<\/script>/u);
assert.ok(
  prefetchedHtml.indexOf('id="app-bootstrap-skeleton"') <
    prefetchedHtml.indexOf("data-okou-api-bootstrap"),
);

const timedOutPrefetch = await responseSnapshot(
  workerModule.createWorker(
    embeddedShell,
    clerkClientReturning({
      headers: new Headers(),
      isAuthenticated: true,
      toAuth() {
        return {
          userId: "user_prefetch_timeout",
          sessionId: "sess_prefetch_timeout",
          orgId: "org_prefetch_timeout",
        };
      },
    }),
    (input, init) => {
      const path = new URL(input).pathname;
      if (path === "/api/feature-switches") {
        return Promise.resolve(
          Response.json({ switches: {}, effectiveSwitches: {} }),
        );
      }
      if (path !== "/api/agents") {
        return Promise.resolve(new Response(null, { status: 402 }));
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            reject(new Error("App API prefetch deadline reached"));
          },
          { once: true },
        );
      });
    },
  ),
  edgePreviewUrl,
  edgePreviewEnvironment,
);
assert.match(timedOutPrefetch.body, /id="app-bootstrap-skeleton"/u);
assert.deepEqual(prefetchedApiPaths(timedOutPrefetch.body), [
  "/api/feature-switches",
]);
assert.deepEqual(
  prefetchedApiJson(timedOutPrefetch.body, "/api/feature-switches"),
  { switches: {}, effectiveSwitches: {} },
);
assert.doesNotMatch(timedOutPrefetch.body, /api%2Fagents/u);
assert.doesNotMatch(timedOutPrefetch.body, /api%2Fuser-preferences/u);
assert.deepEqual(clerkEdgeSessionJson(timedOutPrefetch.body), {
  userId: "user_prefetch_timeout",
  sessionId: "sess_prefetch_timeout",
});

const embeddedServiceWorker = await embeddedWorker.fetch(
  new Request("https://pr-25304-app-okou-app-preview.vm0.workers.dev/sw.js"),
  {},
);
assert.equal(
  await embeddedServiceWorker.text(),
  'self.addEventListener("install", () => {});',
);
assert.equal(
  embeddedServiceWorker.headers.get("content-type"),
  "application/javascript; charset=UTF-8",
);
assert.equal(embeddedServiceWorker.headers.get("service-worker-allowed"), "/");

const embeddedIcon = await embeddedWorker.fetch(
  new Request(
    "https://pr-25304-app-okou-app-preview.vm0.workers.dev/icons/icon-192.png",
  ),
  {},
);
assert.equal(embeddedIcon.headers.get("content-type"), "image/png");
assert.equal(await embeddedIcon.text(), "icon-192");

const embeddedFavicon = await embeddedWorker.fetch(
  new Request("https://app.okou.ai/favicon.ico"),
  {},
);
assert.equal(embeddedFavicon.status, 200);
assert.equal(embeddedFavicon.headers.get("content-type"), "image/x-icon");
assert.equal(
  embeddedFavicon.headers.get("cache-control"),
  "public, max-age=3600, must-revalidate",
);
assert.deepEqual(Buffer.from(await embeddedFavicon.arrayBuffer()), favicon);

const manifestResponse = await worker.fetch(
  new Request("https://app.okou.ai/manifest.webmanifest"),
  assetEnvironment(),
);
const manifest = await manifestResponse.json();
assert.equal(manifestResponse.headers.get("content-encoding"), null);
assert.equal(manifestResponse.headers.get("etag"), null);
assert.equal(
  manifestResponse.headers.get("content-type"),
  "application/manifest+json; charset=UTF-8",
);
assert.equal(manifest.name, "Okou");
assert.equal(manifest.short_name, "Okou");
assert.equal(manifest.description, okouDescription);
assert.equal(manifest.id, "/?source=pwa");
assert.equal(manifest.icons.length, 3);

let observedR2Key = null;
let observedR2Options = null;
const proxiedAsset = await worker.fetch(
  new Request(
    "https://app.okou.ai/okou-app/assets/shared-database-worker-AbCd1234.js",
    {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=secret",
        Range: "bytes=0-1023",
      },
    },
  ),
  assetEnvironment(),
);
assert.equal(
  observedR2Key,
  "okou-app/assets/shared-database-worker-AbCd1234.js",
);
assert.equal(observedR2Options?.range.get("range"), "bytes=0-1023");
assert.equal(observedR2Options?.range.get("authorization"), null);
assert.equal(observedR2Options?.range.get("cookie"), null);
assert.equal(await proxiedAsset.text(), "export const worker = true;");
assert.equal(proxiedAsset.status, 206);
assert.equal(proxiedAsset.headers.get("content-range"), "bytes 0-26/27");
assert.equal(
  proxiedAsset.headers.get("cache-control"),
  "public, max-age=31536000, immutable",
);

let publicAssetRequest = null;
globalThis.fetch = (input) => {
  publicAssetRequest = input instanceof Request ? input : new Request(input);
  return Promise.resolve(
    new Response("export const publicWorker = true;", {
      headers: { "Content-Type": "application/javascript" },
    }),
  );
};
const publicOriginEnvironment = assetEnvironment();
delete publicOriginEnvironment.STATIC_ASSETS_BUCKET;
const publicOriginProxiedAsset = await worker.fetch(
  new Request(
    "https://app.okou.ai/okou-app/assets/shared-database-worker-Legacy123.js",
    {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "secret=true",
        Range: "bytes=0-1023",
      },
    },
  ),
  publicOriginEnvironment,
);
assert.equal(
  publicAssetRequest?.url,
  "https://static.okou.io/okou-app/assets/shared-database-worker-Legacy123.js",
);
assert.equal(publicAssetRequest?.headers.get("authorization"), null);
assert.equal(publicAssetRequest?.headers.get("cookie"), null);
assert.equal(publicAssetRequest?.headers.get("range"), "bytes=0-1023");
assert.equal(
  await publicOriginProxiedAsset.text(),
  "export const publicWorker = true;",
);

async function requestSharedPage({ appOrigin, query = "", metaResponse }) {
  let observedUrl = null;
  let observedHeaders = null;
  globalThis.fetch = (input, init) => {
    observedUrl = String(input);
    observedHeaders = new Headers(init?.headers);
    return Promise.resolve(metaResponse());
  };
  const response = await worker.fetch(
    new Request(`${appOrigin}/share/threads/${sharedThreadId}${query}`),
    assetEnvironment(),
  );
  return { response, observedUrl, observedHeaders };
}

const preview = await requestSharedPage({
  appOrigin: "https://pr-25304-app.omby.ai",
  query: "?x-vercel-protection-bypass=preview-secret",
  metaResponse() {
    return Response.json({
      title: "Preview conversation",
      publicBrand: "okou",
    });
  },
});
assert.equal(preview.response.status, 200);
assert.equal(
  preview.observedUrl,
  `${previewOrigin}/api/shared-threads/${sharedThreadId}/meta`,
);
assert.equal(
  preview.observedHeaders.get("x-vercel-protection-bypass"),
  "preview-secret",
);
const previewHtml = await preview.response.text();
assert.equal(documentTitle(previewHtml), "Preview conversation | Okou");
assert.equal(htmlAttribute(previewHtml, "data-app-brand-name"), "Okou");
assert.equal(
  metaContent(previewHtml, "property", "og:title"),
  "Preview conversation",
);
assert.equal(
  metaContent(previewHtml, "property", "og:url"),
  `https://app.okou.ai/share/threads/${sharedThreadId}`,
);
assert.equal(
  metaContent(previewHtml, "property", "og:image"),
  "https://static.okou.io/web/okou-og-image-373c892e.png",
);
assert.equal(
  metaContent(previewHtml, "name", "twitter:image"),
  "https://static.okou.io/web/okou-og-image-373c892e.png",
);
assert.equal(
  tagAttribute(previewHtml, "link", "rel", "canonical", "href"),
  null,
);

const production = await requestSharedPage({
  appOrigin: "https://app.okou.ai",
  query: "?x-vercel-protection-bypass=must-not-forward",
  metaResponse() {
    return Response.json({
      title: "Production conversation",
      publicBrand: "okou",
    });
  },
});
assert.equal(production.response.status, 200);
assert.equal(
  production.observedUrl,
  `https://api.okou.ai/api/shared-threads/${sharedThreadId}/meta`,
);
assert.equal(
  production.observedHeaders.get("x-vercel-protection-bypass"),
  null,
);

const missing = await requestSharedPage({
  appOrigin: "https://app.okou.ai",
  metaResponse() {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 },
    );
  },
});
assert.equal(missing.response.status, 404);
assert.equal(
  missing.observedUrl,
  `https://api.okou.ai/api/shared-threads/${sharedThreadId}/meta`,
);
assert.equal(
  missing.response.headers.get("cache-control"),
  "public, max-age=60, s-maxage=60",
);
assert.equal(missing.response.headers.get("x-robots-tag"), "noindex, nofollow");
const missingHtml = await missing.response.text();
assert.equal(
  documentTitle(missingHtml),
  "Shared conversation not found | Okou",
);
assert.equal(metaContent(missingHtml, "property", "og:title"), null);
assert.equal(metaContent(missingHtml, "name", "twitter:title"), null);

const upstreamFailure = await requestSharedPage({
  appOrigin: "https://app.okou.ai",
  metaResponse() {
    return new Response("failed", { status: 500 });
  },
});
assert.equal(upstreamFailure.response.status, 502);
assert.equal(upstreamFailure.response.headers.get("cache-control"), "no-store");

for (const path of [
  "/artifacts/00000000000040008000000000000010.html",
  "/share/artifacts/00000000-0000-4000-8000-000000000010",
]) {
  const artifactHandoff = await worker.fetch(
    new Request(`https://app.okou.ai${path}`),
    assetEnvironment(),
  );
  assert.equal(artifactHandoff.status, 200);
  assert.equal(
    artifactHandoff.headers.get("cache-control"),
    "private, no-store",
  );
  assert.equal(artifactHandoff.headers.get("referrer-policy"), "no-referrer");
  assert.doesNotMatch(await artifactHandoff.text(), /<iframe/iu);
}

console.log("okou app worker tests passed");
