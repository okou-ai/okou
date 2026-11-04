#!/usr/bin/env node
/** Release-only publication. Credentials come from the environment, never argv. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compareExtensionVersions,
  listOkouBrowserExtensions,
} from "./browser-extension-registry.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const repository = required("GITHUB_REPOSITORY");
if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error("Invalid repository");
const githubOrigin = origin(
  process.env.GITHUB_API_URL ?? "https://api.github.com",
);
const providerOrigin = origin(
  process.env.BROWSER_USE_API_URL ?? "https://api.browser-use.com",
);
const root = `/repos/${repository}`;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function origin(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
  ) {
    throw new Error("Invalid release API origin");
  }
  return url.origin;
}

async function json(response, service) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${service} returned invalid JSON`);
  }
}

async function github(path, { raw = false, binary = false } = {}) {
  const url = new URL(path, githubOrigin);
  if (
    url.origin !== githubOrigin &&
    !(url.protocol === "https:" && url.hostname === "uploads.github.com")
  ) {
    throw new Error("Unexpected GitHub upload origin");
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${required("GH_TOKEN")}`,
      Accept:
        raw || binary
          ? "application/octet-stream"
          : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`GitHub GET failed (${response.status})`);
  if (binary) return Buffer.from(await response.arrayBuffer());
  return json(response, "GitHub");
}

async function asset(release, name, body, contentType = "application/json") {
  const url = new URL(release.upload_url.split("{")[0]);
  if (
    url.origin !== githubOrigin &&
    !(url.protocol === "https:" && url.hostname === "uploads.github.com")
  ) {
    throw new Error("Unexpected GitHub upload origin");
  }
  url.searchParams.set("name", name);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${required("GH_TOKEN")}`,
      "Content-Type": contentType,
    },
    body: contentType === "application/json" ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok)
    throw new Error(`Release receipt publication failed (${response.status})`);
  await response.arrayBuffer();
}

async function retain(release, name, bytes, contentType) {
  const existing = release.assets.find((item) => item.name === name);
  if (existing) {
    const saved = await github(`${root}/releases/assets/${existing.id}`, {
      binary: true,
    });
    if (!saved.equals(bytes))
      throw new Error(`Conflicting release artifact: ${name}`);
  } else {
    await asset(release, name, bytes, contentType);
  }
}

async function latest(version) {
  const refs = await github(
    `${root}/git/matching-refs/tags/browser-extension-v`,
  );
  if (!Array.isArray(refs))
    throw new Error("Invalid extension release references");
  const selected = version.split(".").map(Number);
  for (const ref of refs) {
    const match = /^refs\/tags\/browser-extension-v(\d+)\.(\d+)\.(\d+)$/.exec(
      ref.ref,
    );
    if (!match) continue;
    const candidate = match.slice(1).map(Number);
    const difference = candidate.findIndex(
      (part, index) => part !== selected[index],
    );
    if (difference !== -1 && candidate[difference] > selected[difference]) {
      throw new Error(
        "This extension release was superseded; refusing to upload older artifacts",
      );
    }
  }
}

function matches(receipt, expected) {
  return (
    receipt &&
    Object.entries(expected).every(([key, value]) => receipt[key] === value)
  );
}

async function pruneExtensions(extensionId, version) {
  const extensions = await listOkouBrowserExtensions(
    providerOrigin,
    required("OKOU_BROWSER_USE_API_KEY"),
  );
  extensions.sort((left, right) => compareExtensionVersions(right, left));
  for (let index = 1; index < extensions.length; index++) {
    if (
      compareExtensionVersions(extensions[index - 1], extensions[index]) === 0
    )
      throw new Error("Browser Use returned ambiguous Okou Browser versions");
  }
  if (
    !extensions.slice(0, 5).some((item) => {
      return item.id === extensionId && item.version === version;
    })
  ) {
    throw new Error(
      "Published extension is not among the retained Browser Use versions",
    );
  }
  for (const item of extensions.slice(5)) {
    const response = await fetch(
      `${providerOrigin}/api/v4/extensions/${item.id}`,
      {
        method: "DELETE",
        headers: {
          "X-Browser-Use-API-Key": required("OKOU_BROWSER_USE_API_KEY"),
        },
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
      },
    );
    // Another cleanup may already have removed this exact provider reference.
    if (response.status !== 204 && response.status !== 404)
      throw new Error(
        `Browser Use extension cleanup failed (${response.status})`,
      );
  }
}

async function publish() {
  required("GH_TOKEN");
  required("OKOU_BROWSER_USE_API_KEY");
  const sourceCommit = required("RELEASE_TARGET");
  const version = required("BROWSER_EXTENSION_VERSION");
  const tag = required("BROWSER_EXTENSION_TAG");
  if (
    !/^[0-9a-f]{40}$/.test(sourceCommit) ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    tag !== `browser-extension-v${version}`
  ) {
    throw new Error("Invalid extension release identity");
  }
  const directory = resolve(
    process.env.EXTENSION_ARTIFACT_DIR ??
      "turbo/apps/browser-extension/artifacts",
  );
  const name = `browser-extension-${version}.zip`;
  const path = resolve(directory, name);
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const provenance = JSON.parse(
    await readFile(`${path}.provenance.json`, "utf8"),
  );
  const expected = { sourceCommit, version, sha256 };
  if (
    !matches(provenance, expected) ||
    provenance.dirty !== false ||
    provenance.extension !== "browser-extension" ||
    (await readFile(`${path}.sha256`, "utf8")).trim() !== `${sha256}  ${name}`
  ) {
    throw new Error(
      "Extension artifact provenance does not match the selected release",
    );
  }
  const entries = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" })
    .trim()
    .split("\n")
    .sort();
  const manifest = JSON.parse(
    execFileSync("unzip", ["-p", path, "manifest.json"], { encoding: "utf8" }),
  );
  if (
    JSON.stringify(entries) !==
      JSON.stringify(["background.js", "manifest.json"]) ||
    manifest.version !== version ||
    manifest.name !== "Okou Browser" ||
    manifest.manifest_version !== 3
  ) {
    throw new Error("Invalid extension ZIP contents");
  }
  const release = await github(`${root}/releases/tags/${tag}`);
  const commit = await github(`${root}/commits/${tag}`);
  if (
    commit.sha !== sourceCommit ||
    release.draft ||
    !Array.isArray(release.assets)
  )
    throw new Error("Release tag/source mismatch");
  await latest(version);
  // Keep the exact verified inputs available for audit and recovery without clobbering history.
  await retain(release, name, bytes, "application/zip");
  await retain(
    release,
    `${name}.sha256`,
    await readFile(`${path}.sha256`),
    "text/plain",
  );
  await retain(
    release,
    `${name}.provenance.json`,
    await readFile(`${path}.provenance.json`),
    "application/octet-stream",
  );
  const completed = release.assets.find(
    (item) => item.name === "browser-extension-upload.json",
  );
  let extensionId;
  if (completed) {
    const receipt = await github(`${root}/releases/assets/${completed.id}`, {
      raw: true,
    });
    if (!matches(receipt, expected) || !uuid.test(receipt.extensionId))
      throw new Error("Conflicting extension upload receipt");
    extensionId = receipt.extensionId;
  } else {
    if (
      release.assets.some(
        (item) => item.name === "browser-extension-upload-attempt.json",
      )
    ) {
      throw new Error(
        "An upload attempt has no completion receipt; reconcile that attempt before rerunning",
      );
    }
    // Publish intent first. A lost provider reply must never trigger another upload.
    await asset(release, "browser-extension-upload-attempt.json", expected);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/zip" }), name);
    const response = await fetch(`${providerOrigin}/api/v4/extensions`, {
      method: "POST",
      headers: {
        "X-Browser-Use-API-Key": required("OKOU_BROWSER_USE_API_KEY"),
      },
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok)
      throw new Error(
        `Browser Use upload failed (${response.status}); reconcile the recorded attempt`,
      );
    const uploaded = await json(response, "Browser Use");
    if (!uuid.test(uploaded.id))
      throw new Error("Browser Use returned an invalid uploaded extension ID");
    if (uploaded.name !== manifest.name || uploaded.version !== version)
      throw new Error(
        "Browser Use returned a different extension name or version",
      );
    extensionId = uploaded.id;
    console.log(
      `Browser Use registered ${extensionId}; source ${sourceCommit}; sha256 ${sha256}`,
    );
    await asset(release, "browser-extension-upload.json", {
      ...expected,
      extensionId,
    });
  }
  // A completed receipt also resumes interrupted cleanup without another upload.
  await pruneExtensions(extensionId, version);
  return extensionId;
}

try {
  const extensionId = await publish();
  await appendFile(required("GITHUB_OUTPUT"), `extension_id=${extensionId}\n`);
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Browser extension publication failed",
  );
  process.exitCode = 1;
}
