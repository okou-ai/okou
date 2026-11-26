import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  releaseCommit,
  verifyDistribution,
} from "./distribution-availability.mjs";
import { readAvailability } from "../../.github/scripts/checks/read-ios-availability.mjs";

const appId = "6815550027";
const sha = "a".repeat(40);
const version = "1.2.0";
const build = "51";
const testable = {
  version: build,
  expired: false,
  processingState: "VALID",
  expirationDate: "2099-01-01T00:00:00Z",
};
function apple(options = {}) {
  const resources = {
    "/v1/apps": [{ id: appId }],
    [`/v1/apps/${appId}/appStoreVersions`]: [
      {
        id: "release",
        attributes: {
          appVersionState: options.state ?? "READY_FOR_DISTRIBUTION",
        },
      },
    ],
    "/v1/appStoreVersions/release/build": {
      data: {
        id: "b",
        attributes: { ...testable, version: options.storeBuild ?? build },
      },
    },
    [`/v1/apps/${appId}/appAvailabilityV2`]: { data: { id: "availability" } },
    "/v2/appAvailabilities/availability/territoryAvailabilities": [
      "USA",
      "JPN",
    ].map((id) => ({
      attributes: {
        available: true,
        contentStatuses:
          id === "JPN"
            ? (options.japanStatuses ?? ["AVAILABLE"])
            : ["AVAILABLE"],
      },
      relationships: { territory: { data: { id } } },
    })),
    "/v1/builds": [
      { id: "b", attributes: { ...testable, ...options.buildAttrs } },
    ],
    "/v1/builds/b/buildBetaDetail": {
      data: {
        attributes: {
          internalBuildState: "IN_BETA_TESTING",
          externalBuildState: "IN_BETA_TESTING",
        },
      },
    },
    [`/v1/apps/${appId}/betaGroups`]: [
      { id: "i", attributes: { name: "Team", isInternalGroup: true } },
      { id: "e", attributes: { name: "Public", isInternalGroup: false } },
    ],
    "/v1/betaGroups/i/relationships/builds": [{ id: "b" }],
    "/v1/betaGroups/e/relationships/builds": options.externalBuilds ?? [
      { id: "b" },
    ],
  };
  const read = async (path) => {
    const result = resources[path.split("?")[0]];
    assert.ok(result, path);
    return result;
  };
  return { list: read, request: read };
}

const store = {
  channel: "app-store",
  version,
  build,
  countries: "US,JP",
  territoryCodes: new Map([
    ["US", "USA"],
    ["JP", "JPN"],
  ]),
};
const beta = {
  channel: "testflight",
  version,
  build,
  internalGroup: "Team",
  externalGroups: "Public",
};
const product = {
  trackId: Number(appId),
  bundleId: "ai.okou.ios",
  kind: "software",
  version,
};
const lookup = async () => ({ results: [product] });

test("public release requires the selected build and matching public listings in every storefront", async () => {
  assert.deepEqual(
    (await verifyDistribution(apple(), store, lookup)).storefronts,
    ["JP", "US"],
  );
  await assert.rejects(
    verifyDistribution(
      apple({ state: "PENDING_DEVELOPER_RELEASE" }),
      store,
      lookup,
    ),
    /not publicly released/,
  );
  await assert.rejects(
    verifyDistribution(apple({ storeBuild: "52" }), store, lookup),
    /valid build/,
  );
  await assert.rejects(
    verifyDistribution(apple(), { ...store, countries: "" }, lookup),
    /STOREFRONTS/,
  );
  await assert.rejects(
    verifyDistribution(apple(), store, async (country) => ({
      results:
        country === "JP" ? [{ ...product, version: "1.1.0" }] : [product],
    })),
    /Storefront JP/,
  );
});

test("verifies a previously public minimum against a newer live replacement and excludes preorders", async () => {
  const historical = apple({ state: "REPLACED_WITH_NEW_VERSION" });
  const newer = async () => ({ results: [{ ...product, version: "1.10.0" }] });
  assert.equal(
    (await verifyDistribution(historical, store, newer)).publishedVersion,
    "1.10.0",
  );
  await assert.rejects(
    verifyDistribution(historical, store, lookup),
    /Storefront JP/,
  );
  await assert.rejects(
    verifyDistribution(
      apple({ japanStatuses: ["AVAILABLE_FOR_PREORDER"] }),
      store,
      lookup,
    ),
    /JP is not available for download/,
  );
});

test("TestFlight requires a currently valid build assigned to each supported group", async () => {
  assert.deepEqual((await verifyDistribution(apple(), beta)).groups, [
    "Team",
    "Public",
  ]);
  await assert.rejects(
    verifyDistribution(apple({ externalBuilds: [] }), beta),
    /unavailable to Public/,
  );
  await assert.rejects(
    verifyDistribution(
      apple({ buildAttrs: { expirationDate: "2020-01-01" } }),
      beta,
    ),
    /expired/,
  );
  await assert.rejects(
    verifyDistribution(apple({ buildAttrs: { expired: true } }), beta),
    /expired/,
  );
});

test("bind the upload to the exact successful publisher step on the release source", () => {
  const read = (path) => {
    if (path.startsWith("git/ref/")) return { object: { type: "commit", sha } };
    if (path.includes("release-please"))
      return {
        workflow_runs: [
          { head_branch: "main", head_sha: sha, event: "push", id: 7 },
        ],
      };
    return [
      {
        name: "publish-ios-testflight",
        head_sha: sha,
        steps: [
          {
            name: `Verified iOS ${version} (${build}) at ${sha}`,
            conclusion: "success",
          },
        ],
      },
    ];
  };
  assert.equal(releaseCommit(read, version, build), sha);
  assert.throws(
    () => releaseCommit(read, version, "52"),
    /No protected release/,
  );
});

test("PRs accept only fresh, scope-matched receipts from the latest main dispatch and exact attempt", async () => {
  const repo = "okou-ai/okou";
  const now = Date.parse("2026-11-23T00:00:00Z");
  const scope = createHash("sha256").update("JP,US").digest("hex");
  const run = {
    id: 9,
    run_attempt: 2,
    head_branch: "main",
    head_sha: sha,
    event: "workflow_dispatch",
    head_repository: { full_name: repo },
    status: "completed",
    conclusion: "success",
    display_title: "Verify iOS app-store availability",
  };
  const read =
    (runs, age = 1) =>
    async (path) => {
      if (path.includes("workflows/")) return { workflow_runs: runs };
      assert.equal(path, "actions/runs/9/attempts/2/jobs?per_page=100");
      return {
        jobs: [
          {
            name: "verify",
            head_sha: sha,
            conclusion: "success",
            steps: [
              {
                name: `iOS availability receipt app-store ${version} ${build} ${sha} ${scope} 0 ${version}`,
                conclusion: "success",
                completed_at: new Date(now - age).toISOString(),
              },
            ],
          },
        ],
      };
    };
  assert.equal(
    (await readAvailability(read([run]), repo, "US,JP", now))["app-store"]
      .commit,
    sha,
  );
  for (const [reader, regions] of [
    [read([{ ...run, conclusion: "failure" }, run]), "US,JP"],
    [read([{ ...run, status: "in_progress" }, run]), "US,JP"],
    [read([run]), "US"],
    [read([run], 86400000), "US,JP"],
    [read([{ ...run, head_branch: "feature" }]), "US,JP"],
  ])
    assert.deepEqual(await readAvailability(reader, repo, regions, now), {});
});

test("a beta receipt stops authorizing a raise when the Apple build expires", async () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const repository = "okou-ai/okou";
  const read = (expiry) => async (path) =>
    path.includes("workflows/")
      ? {
          workflow_runs: [
            {
              id: 25,
              run_attempt: 1,
              head_branch: "main",
              event: "workflow_dispatch",
              head_sha: sha,
              head_repository: { full_name: repository },
              display_title: "Verify iOS testflight availability",
              conclusion: "success",
              status: "completed",
            },
          ],
        }
      : {
          jobs: [
            {
              name: "verify",
              head_sha: sha,
              conclusion: "success",
              steps: [
                {
                  name: `iOS availability receipt testflight ${version} ${build} ${sha} ${"b".repeat(64)} ${expiry} -`,
                  conclusion: "success",
                  completed_at: new Date(now - 1000).toISOString(),
                },
              ],
            },
          ],
        };
  assert.deepEqual(
    (await readAvailability(read(now + 1), repository, "", now)).testflight,
    { version, build, commit: sha },
  );
  assert.deepEqual(await readAvailability(read(now), repository, "", now), {});
});

test("internal-only builds are valid for TestFlight availability", async () => {
  const internal = apple({
    buildAttrs: { buildAudienceType: "INTERNAL_ONLY" },
  });
  assert.equal((await verifyDistribution(internal, beta)).appleBuildId, "b");
});
