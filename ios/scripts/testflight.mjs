import { createPrivateKey, sign } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const origin = "https://api.appstoreconnect.apple.com";
const bundleId = "ai.okou.ios";

// The injected origin is only used by the loopback integration tests. The CLI
// always uses Apple's canonical origin, including when following pagination.
export class AppStoreConnect {
  constructor({ keyId, issuerId, privateKey, apiOrigin = origin }) {
    this.keyId = keyId;
    this.issuerId = issuerId;
    this.privateKey = createPrivateKey(privateKey);
    this.origin = apiOrigin;
  }

  async request(path, { method = "GET", body } = {}) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin)
      throw new Error("Unexpected Apple API pagination origin");
    const now = Math.floor(Date.now() / 1000);
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${encode({ alg: "ES256", kid: this.keyId, typ: "JWT" })}.${encode({ iss: this.issuerId, iat: now - 10, exp: now + 600, aud: "appstoreconnect-v1" })}`;
    const signature = sign("sha256", Buffer.from(payload), {
      key: this.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const response = await fetch(url, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${payload}.${signature}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // Do not print the response body or request headers: they can contain
      // account information. HTTP failures never mean 'no build yet'.
      throw new Error(
        `App Store Connect ${method} ${url.pathname}: HTTP ${response.status}`,
      );
    }
    return response.status === 204 ? undefined : response.json();
  }

  async list(path) {
    const resources = [];
    const seen = new Set();
    while (path) {
      if (seen.has(path)) throw new Error("Repeated Apple API pagination link");
      seen.add(path);
      const response = await this.request(path);
      if (!Array.isArray(response.data))
        throw new Error("Invalid Apple API resource list");
      resources.push(...response.data);
      path = response.links?.next;
    }
    return resources;
  }
}

export async function prepare(client, version, groupName) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Invalid iOS release version");
  const apps = await client.list(
    `/v1/apps?${new URLSearchParams({ "filter[bundleId]": bundleId })}`,
  );
  if (apps.length !== 1)
    throw new Error(`Expected one App Store Connect app for ${bundleId}`);
  const appId = apps[0].id;
  const groups = await client.list(`/v1/apps/${appId}/betaGroups?limit=200`);
  const matching = groups.filter(
    (group) => group.attributes.name === groupName,
  );
  if (
    matching.length !== 1 ||
    matching[0].attributes.isInternalGroup !== true
  ) {
    throw new Error(
      `Configure one internal TestFlight group named ${groupName}`,
    );
  }
  const groupId = matching[0].id;
  const testers = await client.list(
    `/v1/betaGroups/${groupId}/betaTesters?limit=200`,
  );
  if (testers.length === 0)
    throw new Error("The internal TestFlight group has no testers");
  // Production releases are serialized by the existing deployment queue. Keep
  // build numbers increasing across marketing versions, including failed builds.
  const builds = await client.list(
    `/v1/builds?${new URLSearchParams({ "filter[app]": appId, limit: "200" })}`,
  );
  let maximum = 0;
  for (const build of builds) {
    const number = build.attributes.version;
    if (!/^[1-9]\d{0,3}$/.test(number))
      throw new Error(
        `Existing build number is not a supported integer: ${number}`,
      );
    maximum = Math.max(maximum, Number(number));
  }
  if (maximum >= 9999) throw new Error("iOS build number range exhausted");
  return { appId, groupId, version, buildNumber: String(maximum + 1) };
}

export async function distribute(
  client,
  release,
  { timeoutMs = 30 * 60_000, pollMs = 30_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let assigned = false;
  do {
    const response = await client.request(
      `/v1/builds?${new URLSearchParams({
        "filter[app]": release.appId,
        "filter[version]": release.buildNumber,
        "filter[preReleaseVersion.version]": release.version,
        "filter[preReleaseVersion.platform]": "IOS",
        include: "buildBetaDetail",
      })}`,
    );
    if (!Array.isArray(response.data) || response.data.length > 1)
      throw new Error("Ambiguous uploaded iOS build");
    const build = response.data[0];
    if (build) {
      const state = build.attributes.processingState;
      if (build.attributes.expired || ["FAILED", "INVALID"].includes(state))
        throw new Error(
          `Apple rejected or expired build ${release.buildNumber}: ${state}`,
        );
      if (state === "VALID") {
        const detailId = build.relationships?.buildBetaDetail?.data?.id;
        const detail = response.included?.find(
          (item) => item.type === "buildBetaDetails" && item.id === detailId,
        );
        const internal = detail?.attributes.internalBuildState;
        if (!internal)
          throw new Error("Apple omitted the internal build state");
        if (
          [
            "PROCESSING_EXCEPTION",
            "MISSING_EXPORT_COMPLIANCE",
            "IN_EXPORT_COMPLIANCE_REVIEW",
            "EXPIRED",
          ].includes(internal)
        ) {
          throw new Error(
            `Internal distribution requires action in App Store Connect: ${internal}`,
          );
        }
        if (["READY_FOR_BETA_TESTING", "IN_BETA_TESTING"].includes(internal)) {
          const group = await client.request(
            `/v1/betaGroups/${release.groupId}`,
          );
          if (group.data.attributes.isInternalGroup !== true)
            throw new Error("Refusing external TestFlight distribution");
          let members = await client.list(
            `/v1/betaGroups/${release.groupId}/relationships/builds?limit=200`,
          );
          if (
            !members.some((member) => member.id === build.id) &&
            group.data.attributes.hasAccessToAllBuilds !== true &&
            !assigned
          ) {
            await client.request(
              `/v1/betaGroups/${release.groupId}/relationships/builds`,
              {
                method: "POST",
                body: { data: [{ type: "builds", id: build.id }] },
              },
            );
            assigned = true;
            members = await client.list(
              `/v1/betaGroups/${release.groupId}/relationships/builds?limit=200`,
            );
          }
          if (
            internal === "IN_BETA_TESTING" &&
            members.some((member) => member.id === build.id)
          )
            return build.id;
        }
        console.log(`Waiting for internal distribution: ${internal}`);
      } else if (state !== "PROCESSING") {
        throw new Error(`Unknown Apple processing state: ${state}`);
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(
    "Timed out waiting for the exact build to become available to internal testers",
  );
}

async function main() {
  const required = (name) => {
    if (!process.env[name]) throw new Error(`${name} is required`);
    return process.env[name];
  };
  const client = new AppStoreConnect({
    keyId: required("APP_STORE_CONNECT_API_KEY_ID"),
    issuerId: required("APP_STORE_CONNECT_API_ISSUER_ID"),
    privateKey: Buffer.from(
      required("APP_STORE_CONNECT_API_KEY_BASE64"),
      "base64",
    ),
  });
  const file = required("IOS_RELEASE_METADATA");
  if (process.argv[2] === "prepare") {
    const release = await prepare(
      client,
      required("IOS_VERSION"),
      required("IOS_INTERNAL_GROUP_NAME"),
    );
    writeFileSync(file, JSON.stringify(release), { mode: 0o600 });
    appendFileSync(
      required("GITHUB_OUTPUT"),
      `build_number=${release.buildNumber}\napp_id=${release.appId}\n`,
    );
  } else if (process.argv[2] === "distribute") {
    const release = JSON.parse(readFileSync(file, "utf8"));
    const buildId = await distribute(client, release);
    appendFileSync(
      required("GITHUB_STEP_SUMMARY"),
      `Okou ${release.version} (${release.buildNumber}) is available to the internal TestFlight group. Build ID: ${buildId}.\n`,
    );
  } else {
    throw new Error(
      "Usage: node ios/scripts/testflight.mjs prepare|distribute",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
