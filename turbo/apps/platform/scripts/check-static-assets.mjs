import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const vendoredMarkdownCssPath = path.join(
  appRoot,
  "src/views/css/vendor/uiw-react-markdown-preview-5.2.0.css",
);
const vendoredMarkdownCssBodyStart = "@media (prefers-color-scheme: dark) {";
const vendoredMarkdownCssSha256 =
  "9ec83e6d9f5791bfd74fdd9dec383a30106d736055faa9655376afa62583d94f";

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function checkStaticAssets() {
  const checkedRoots = ["src", "public"];
  const staticAssetExtensions = new Set([
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".webp",
  ]);
  const sameOriginAssetAllowlist = new Set([
    "public/icons/icon-192.png",
    "public/icons/icon-512-maskable.png",
    "public/icons/icon-512.png",
  ]);
  const violations = [];

  for (const root of checkedRoots) {
    const rootPath = path.join(appRoot, root);
    if (!statSync(rootPath, { throwIfNoEntry: false })?.isDirectory()) {
      continue;
    }

    for (const file of collectFiles(rootPath)) {
      const relativePath = toPosixPath(path.relative(appRoot, file));
      const extension = path.extname(relativePath).toLowerCase();
      if (!staticAssetExtensions.has(extension)) {
        continue;
      }
      if (sameOriginAssetAllowlist.has(relativePath)) {
        continue;
      }
      violations.push(relativePath);
    }
  }

  if (violations.length > 0) {
    process.stderr.write(`Platform static asset lint failed.

These files look like UI illustrations, empty states, brand/logo images, connector/provider icons, or other build-stable png/webp/svg assets:

${violations
  .map((file) => {
    return `  - ${file}`;
  })
  .join("\n")}

Do not commit this kind of asset to vm0. Add it to okou-ai/static-files under static.vm0.io/platform/... using a versioned or content-hashed path.

static.vm0.io is append-only and hard cached for one year. Never overwrite, rename, or delete an existing published path; add a new unique path instead.

In platform code, reference the CDN asset with platformStaticAssetUrl("..."), or add it to the existing platform asset URL map when a typed/shared constant is useful. For example:

  platformStaticAssetUrl("views/zero-page/assets/example-<hash>.webp")

Only same-origin browser assets such as manifest or push-notification icons should be allowlisted here, with a narrow path-specific exception.
`);
    process.exit(1);
  }
}

function checkVendoredMarkdownCss() {
  const requiredHeader = [
    "@uiw/react-markdown-preview@5.2.0, package/markdown.css",
    "https://unpkg.com/@uiw/react-markdown-preview@5.2.0/markdown.css",
    "https://github.com/uiwjs/react-markdown-preview/tree/v5.2.0",
    "SPDX-License-Identifier: MIT",
    "Copyright (c) 2020 uiw",
  ];
  const requiredSelectors = [
    "[data-color-mode*='dark'] .wmde-markdown",
    ".wmde-markdown .token.comment",
    ".wmde-markdown .token.keyword",
    ".wmde-markdown .highlight-line",
    ".wmde-markdown .code-line.line-number::before",
    ".wmde-markdown .markdown-alert",
    ".wmde-markdown .task-list-item",
    ".wmde-markdown pre .copied",
  ];
  const css = readFileSync(vendoredMarkdownCssPath, "utf8");
  const bodyStart = css.indexOf(vendoredMarkdownCssBodyStart);
  const violations = [];

  if (bodyStart === -1) {
    violations.push("published CSS body marker is missing");
  } else {
    const header = css.slice(0, bodyStart);
    const body = css.slice(bodyStart);
    const actualSha256 = createHash("sha256").update(body).digest("hex");

    if (actualSha256 !== vendoredMarkdownCssSha256) {
      violations.push(
        `published CSS body changed (expected sha256 ${vendoredMarkdownCssSha256}, received ${actualSha256})`,
      );
    }

    for (const requiredText of requiredHeader) {
      if (header.indexOf(requiredText) === -1) {
        violations.push(`attribution header is missing: ${requiredText}`);
      }
    }

    for (const selector of requiredSelectors) {
      if (body.indexOf(selector) === -1) {
        violations.push(`required upstream selector is missing: ${selector}`);
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write(
      `Vendored Markdown CSS lint failed.\n\n${violations
        .map((violation) => {
          return `  - ${violation}`;
        })
        .join("\n")}\n`,
    );
    process.exit(1);
  }
}

checkStaticAssets();
checkVendoredMarkdownCss();
