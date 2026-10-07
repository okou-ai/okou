import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "end of input"}`);
    }
    const name = key.slice(2);
    if (
      ![
        "manifest",
        "version",
        "zip-url",
        "channel",
        "platform",
        "arch",
        "pub-date",
      ].includes(name)
    ) {
      throw new Error(`Unknown argument: ${key}`);
    }
    args.set(name, value);
  }
  return args;
}

function requiredArg(args, name) {
  const value = args.get(name);
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function readManifest(path) {
  if (!existsSync(path)) {
    return {
      schemaVersion: 1,
      product: "okou",
      channels: {},
      releases: {},
    };
  }

  return JSON.parse(readFileSync(path, "utf8"));
}

function ensureRecord(value, fallback = {}) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  return fallback;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = requiredArg(args, "manifest");
const version = requiredArg(args, "version");
const zipUrl = requiredArg(args, "zip-url");
const channel = args.get("channel") ?? "stable";
const platform = args.get("platform") ?? "darwin";
const arch = args.get("arch") ?? "arm64";
const pubDate = args.get("pub-date") ?? new Date().toISOString();

const expectedZipAssetName = `Okou-${platform}-${arch}-${version}.zip`;
const actualZipAssetName = decodeURIComponent(
  new URL(zipUrl).pathname.split("/").at(-1) ?? "",
);
if (actualZipAssetName !== expectedZipAssetName) {
  throw new Error(
    `Desktop update asset must be ${expectedZipAssetName}, received ${actualZipAssetName}`,
  );
}

const manifest = ensureRecord(readManifest(manifestPath));
if (manifest.product !== "okou") {
  throw new Error(
    `Desktop update manifest product mismatch: expected okou, received ${manifest.product}`,
  );
}
manifest.schemaVersion = 1;
manifest.product = "okou";
manifest.channels = ensureRecord(manifest.channels);
manifest.releases = ensureRecord(manifest.releases);

const currentChannel = ensureRecord(manifest.channels[channel], {
  blocked: [],
});
const blocked = Array.isArray(currentChannel.blocked)
  ? currentChannel.blocked
  : [];
manifest.channels[channel] = {
  ...currentChannel,
  latest: version,
  blocked,
};

const currentRelease = ensureRecord(manifest.releases[version]);
const platforms = ensureRecord(currentRelease.platforms);
const platformAssets = ensureRecord(platforms[platform]);
platformAssets[arch] = { url: zipUrl };
platforms[platform] = platformAssets;

manifest.releases[version] = {
  ...currentRelease,
  version,
  name: currentRelease.name ?? `Okou ${version}`,
  notes: currentRelease.notes ?? "",
  pubDate,
  platforms,
};

mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
