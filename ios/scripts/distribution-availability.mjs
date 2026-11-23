import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { appleClientFromEnvironment, required } from "./testflight.mjs";

const appId = "6815550027";
const bundleId = "ai.okou.ios";

function one(resources, description) {
  if (resources.length !== 1)
    throw new Error(`Expected exactly one ${description}`);
  return resources[0];
}

// The release publisher records the verified build number and actual checkout
// together. A tag alone cannot distinguish multiple uploads of one version.
export function releaseCommit(read, version, build) {
  const tag = read(`git/ref/tags/ios-v${version}`).object;
  if (tag.type !== "commit" || !/^[0-9a-f]{40}$/u.test(tag.sha)) {
    throw new Error("Expected an iOS release tag pointing to a commit");
  }
  const { workflow_runs: runs } = read(
    `actions/workflows/release-please.yml/runs?branch=main&event=push&head_sha=${tag.sha}&per_page=100`,
  );
  const marker = `Verified iOS ${version} (${build}) at ${tag.sha}`;
  for (const run of runs) {
    if (
      run.head_branch !== "main" ||
      run.event !== "push" ||
      run.head_sha !== tag.sha
    )
      continue;
    const jobs = read(
      `actions/runs/${run.id}/jobs?filter=all&per_page=100`,
      true,
    );
    if (
      jobs.some(
        (job) =>
          job.name === "publish-ios-testflight" &&
          job.head_sha === tag.sha &&
          job.steps?.some(
            (step) => step.name === marker && step.conclusion === "success",
          ),
      )
    ) {
      return tag.sha;
    }
  }
  throw new Error(
    "No protected release verification matches this exact version and build",
  );
}

export function storefronts(value) {
  const countries = value
    .split(",")
    .map((country) => country.trim().toUpperCase())
    .sort();
  if (
    countries.some((country) => !/^[A-Z]{2}$/u.test(country)) ||
    new Set(countries).size !== countries.length
  ) {
    throw new Error(
      "Configure IOS_APP_STORE_STOREFRONTS with unique two-letter countries",
    );
  }
  return countries;
}

async function catalog(country) {
  const url = new URL("https://itunes.apple.com/lookup");
  url.search = new URLSearchParams({ id: appId, country, entity: "software" });
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`App Store lookup for ${country}: HTTP ${response.status}`);
  return response.json();
}

export async function verifyDistribution(
  client,
  { channel, version, build, countries, internalGroup, externalGroups },
  lookup = catalog,
) {
  const app = one(
    await client.list(
      `/v1/apps?${new URLSearchParams({ "filter[bundleId]": bundleId })}`,
    ),
    "Okou app",
  );
  if (app.id !== appId) throw new Error("Unexpected App Store Connect app ID");
  if (channel === "app-store") {
    const release = one(
      await client.list(
        `/v1/apps/${appId}/appStoreVersions?${new URLSearchParams({ "filter[versionString]": version, "filter[platform]": "IOS" })}`,
      ),
      "iOS App Store version",
    );
    const state =
      release.attributes.appVersionState ?? release.attributes.appStoreState;
    if (!["READY_FOR_DISTRIBUTION", "READY_FOR_SALE"].includes(state)) {
      throw new Error(`App Store version is not publicly released: ${state}`);
    }
    const selected = (
      await client.request(`/v1/appStoreVersions/${release.id}/build`)
    ).data;
    if (
      selected?.attributes.version !== build ||
      selected.attributes.processingState !== "VALID"
    ) {
      throw new Error("App Store release does not use this valid build");
    }
    const regions = storefronts(countries);
    for (const country of regions) {
      const product = (await lookup(country)).results.find(
        (entry) =>
          String(entry.trackId) === appId &&
          entry.bundleId === bundleId &&
          entry.kind === "software",
      );
      if (product?.version !== version)
        throw new Error(
          `Storefront ${country} serves ${product?.version ?? "no Okou app"}; expected ${version}`,
        );
    }
    return { storefronts: regions, appleBuildId: selected.id };
  }

  if (channel !== "testflight" || !internalGroup?.trim())
    throw new Error("A TestFlight check requires an internal group");
  const uploaded = one(
    await client.list(
      `/v1/builds?${new URLSearchParams({ "filter[app]": appId, "filter[version]": build, "filter[preReleaseVersion.version]": version, "filter[preReleaseVersion.platform]": "IOS" })}`,
    ),
    "iOS TestFlight build",
  );
  const {
    version: buildNumber,
    processingState,
    expired,
    expirationDate,
  } = uploaded.attributes;
  if (
    buildNumber !== build ||
    expired !== false ||
    processingState !== "VALID" ||
    !(Date.parse(expirationDate) > Date.now())
  ) {
    throw new Error("TestFlight build is invalid or expired");
  }
  const detail = (
    await client.request(`/v1/builds/${uploaded.id}/buildBetaDetail`)
  ).data.attributes;
  const supported = [
    internalGroup,
    ...(externalGroups ?? "")
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean),
  ];
  const groups = await client.list(`/v1/apps/${appId}/betaGroups?limit=200`);
  for (const [index, name] of supported.entries()) {
    const group = one(
      groups.filter((entry) => entry.attributes.name === name),
      `TestFlight group named ${name}`,
    );
    const internal = index === 0;
    const state = internal
      ? detail.internalBuildState
      : detail.externalBuildState;
    if (
      group.attributes.isInternalGroup !== internal ||
      state !== "IN_BETA_TESTING"
    ) {
      throw new Error(`Build is not in testing for group ${name}`);
    }
    const members = await client.list(
      `/v1/betaGroups/${group.id}/relationships/builds?limit=200`,
    );
    if (!members.some((entry) => entry.id === uploaded.id))
      throw new Error(`Build is unavailable to ${name}`);
  }
  return {
    expiresAt: expirationDate,
    appleBuildId: uploaded.id,
    groups: supported,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const version = required("IOS_VERSION");
    const build = required("IOS_BUILD_NUMBER");
    const channel = required("IOS_CHANNEL");
    if (
      !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/u.test(version) ||
      !/^[1-9]\d{0,3}$/u.test(build)
    ) {
      throw new Error(
        "Supply a stable marketing version and an integer Apple build number",
      );
    }
    const prefix = `repos/${required("GITHUB_REPOSITORY")}/`;
    const read = (path, paginate) => {
      const raw = execFileSync(
        "gh",
        ["api", ...(paginate ? ["--paginate", "--slurp"] : []), prefix + path],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      const data = JSON.parse(raw);
      return paginate ? data.flatMap((page) => page.jobs) : data;
    };
    const commit = releaseCommit(read, version, build);
    const availability = await verifyDistribution(
      appleClientFromEnvironment(),
      {
        channel,
        version,
        build,
        countries: process.env.IOS_APP_STORE_STOREFRONTS ?? "",
        internalGroup: process.env.IOS_INTERNAL_GROUP_NAME,
        externalGroups: process.env.IOS_EXTERNAL_GROUP_NAMES,
      },
    );
    const receipt = {
      appId,
      platform: "IOS",
      channel,
      version,
      build,
      commit,
      ...availability,
      verifiedAt: new Date().toISOString(),
    };
    writeFileSync(
      required("IOS_AVAILABILITY_OUTPUT"),
      JSON.stringify(receipt) + "\n",
    );
    const scope = createHash("sha256")
      .update((availability.storefronts ?? availability.groups).join(","))
      .digest("hex");
    const expiry =
      channel === "testflight" ? Date.parse(availability.expiresAt) : 0;
    appendFileSync(
      required("GITHUB_OUTPUT"),
      `identity=${channel} ${version} ${build} ${commit} ${scope} ${expiry}\n`,
    );
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
