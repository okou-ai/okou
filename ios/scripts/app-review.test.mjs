import assert from "node:assert/strict";
import test from "node:test";
import { submitForReview } from "./app-review.mjs";

const target = {
  version: "0.54.0",
  appleBuildId: "build-196",
  appId: "6815550027",
};
const ref = (id) => ({ data: id ? { id } : null });

function fixture({
  version,
  submission,
  entries = [],
  previous,
  previousItems = [],
  onSubmit,
} = {}) {
  const writes = [],
    saved = [];
  const client = {
    async list(path) {
      const url = new URL(path, "https://apple.invalid");
      if (url.pathname === `/v1/apps/${target.appId}/appStoreVersions`) {
        assert.equal(url.searchParams.get("filter[platform]"), "IOS");
        assert.equal(
          url.searchParams.get("filter[versionString]"),
          target.version,
        );
        assert.equal(url.searchParams.get("include"), "build");
        return version ? [version] : [];
      }
      if (url.pathname === `/v1/apps/${target.appId}/reviewSubmissions`) {
        if (url.searchParams.get("filter[state]") === "COMPLETE")
          return previous ? [previous] : [];
        return submission ? [submission] : [];
      }
      if (url.pathname === `/v1/reviewSubmissions/${submission?.id}/items`)
        return entries;
      if (url.pathname === `/v1/reviewSubmissions/${previous?.id}/items`)
        return previousItems;
      assert.fail(path);
    },
    async request(path, { method = "GET", body } = {}) {
      const { pathname } = new URL(path, "https://apple.invalid");
      const data = body?.data;
      if (method === "GET") {
        if (pathname === `/v1/appStoreVersions/${version?.id}`)
          return { data: version };
        if (pathname === `/v1/reviewSubmissions/${submission?.id}`)
          return { data: submission };
        if (previous && pathname === `/v1/reviewSubmissions/${previous.id}`)
          return { data: previous };
        throw Object.assign(new Error("Missing Apple resource"), {
          status: 404,
        });
      }
      writes.push([method, pathname]);
      if (
        pathname === "/v1/appStoreVersions" ||
        pathname === "/v1/appStoreVersions/version"
      ) {
        assert.equal(data.type, "appStoreVersions");
        if (data.relationships?.build)
          assert.equal(data.relationships.build.data.type, "builds");
        if (method === "POST") {
          assert.deepEqual(data.relationships.app, {
            data: { type: "apps", id: target.appId },
          });
          assert.equal(data.attributes.versionString, target.version);
          assert.equal(data.attributes.platform, "IOS");
        } else assert.equal(data.id, version.id);
        version = storeVersion(
          data.relationships?.build?.data.id ??
            version.relationships.build.data.id,
          data.attributes?.releaseType ?? version.attributes.releaseType,
        );
        return { data: version };
      }
      if (pathname === "/v1/reviewSubmissions" && method === "POST") {
        assert.equal(data.attributes.platform, "IOS");
        assert.equal(data.relationships.app.data.id, target.appId);
        submission = review("READY_FOR_REVIEW");
        return { data: submission };
      }
      if (pathname === "/v1/reviewSubmissionItems" && method === "POST") {
        assert.equal(
          data.relationships.reviewSubmission.data.id,
          submission.id,
        );
        entries.push({
          relationships: {
            appStoreVersion: data.relationships.appStoreVersion,
          },
        });
        return { data: { id: "item" } };
      }
      if (
        pathname === `/v1/reviewSubmissions/${submission?.id}` &&
        method === "PATCH"
      ) {
        assert.deepEqual(data, {
          id: submission.id,
          type: "reviewSubmissions",
          attributes: { submitted: true },
        });
        assert.equal(version.attributes.releaseType, "MANUAL");
        assert.equal(version.relationships.build.data.id, target.appleBuildId);
        assert.equal(entries.length, 1);
        if (onSubmit) await onSubmit(submission);
        else submission.attributes.state = "WAITING_FOR_REVIEW";
        return { data: submission };
      }
      assert.fail(`${method} ${path}`);
    },
  };
  const hooks = {
    saveSubmission: async (id) => saved.push(id),
    assertCurrent: async () => {},
  };
  return {
    run: (extra = {}) =>
      submitForReview(client, target, { ...hooks, ...extra }),
    writes,
    saved,
  };
}
function storeVersion(
  build = target.appleBuildId,
  releaseType = "MANUAL",
  state = "PREPARE_FOR_SUBMISSION",
) {
  return {
    id: "version",
    attributes: {
      releaseType,
      platform: "IOS",
      versionString: target.version,
      appVersionState: state,
    },
    relationships: { build: ref(build) },
  };
}
function review(state, id = "review") {
  return {
    id,
    attributes: { platform: "IOS", state },
    relationships: { app: ref(target.appId) },
  };
}
const versionItem = { relationships: { appStoreVersion: ref("version") } };

test("creates the store version with the existing binary, then submits only that version for manual release", async () => {
  const f = fixture();
  let checks = 0;
  assert.deepEqual(await f.run({ assertCurrent: async () => checks++ }), {
    id: "review",
    state: "WAITING_FOR_REVIEW",
  });
  assert.deepEqual(f.writes, [
    ["POST", "/v1/appStoreVersions"],
    ["POST", "/v1/reviewSubmissions"],
    ["POST", "/v1/reviewSubmissionItems"],
    ["PATCH", "/v1/reviewSubmissions/review"],
  ]);
  assert.equal(checks, f.writes.length);
  assert.deepEqual(f.saved, ["review"]);
});
test("reuses the store draft, selects the exact build and changes release mode to manual", async () => {
  const f = fixture({
    version: storeVersion(null, "AFTER_APPROVAL"),
    submission: review("READY_FOR_REVIEW"),
    entries: [versionItem],
  });
  await f.run();
  assert.deepEqual(f.writes, [
    ["PATCH", "/v1/appStoreVersions/version"],
    ["PATCH", "/v1/reviewSubmissions/review"],
  ]);
});
test("an already-submitted exact version returns the Apple receipt without writes", async () => {
  const f = fixture({
    version: storeVersion(),
    submission: review("IN_REVIEW"),
    entries: [versionItem],
  });
  assert.deepEqual(await f.run(), { id: "review", state: "IN_REVIEW" });
  assert.deepEqual(f.writes, []);
});
for (const [name, options, expected] of [
  [
    "another build",
    { version: storeVersion("other") },
    /already selects Apple build other/,
  ],
  [
    "a foreign draft item",
    {
      version: storeVersion(),
      submission: review("READY_FOR_REVIEW"),
      entries: [{ relationships: { appEvent: ref("other") } }],
    },
    /other items/,
  ],
  [
    "extra items in the same draft",
    {
      version: storeVersion(),
      submission: review("READY_FOR_REVIEW"),
      entries: [versionItem, {}],
    },
    /other items/,
  ],
  [
    "an empty draft without a saved ID",
    { submission: review("READY_FOR_REVIEW") },
    /no verified owner/,
  ],
  [
    "an unresolved review",
    {
      version: storeVersion(),
      submission: review("UNRESOLVED_ISSUES"),
      entries: [versionItem],
    },
    /UNRESOLVED_ISSUES/,
  ],
  [
    "an uneditable version",
    {
      version: storeVersion(
        target.appleBuildId,
        "MANUAL",
        "PENDING_DEVELOPER_RELEASE",
      ),
    },
    /PENDING_DEVELOPER_RELEASE/,
  ],
])
  test(`refuses ${name} before changing Apple`, async () => {
    const f = fixture(options);
    await assert.rejects(f.run(), expected);
    assert.deepEqual(f.writes, []);
  });
test("resumes its own empty Apple draft after a lost runner", async () => {
  const f = fixture({
    version: storeVersion(),
    submission: review("READY_FOR_REVIEW"),
  });
  await f.run({ knownSubmissionId: "review" });
  assert.deepEqual(f.writes, [
    ["POST", "/v1/reviewSubmissionItems"],
    ["PATCH", "/v1/reviewSubmissions/review"],
  ]);
});
test("a cleared candidate stops the final write even after preparing the draft", async () => {
  const f = fixture();
  let writesAllowed = 3;
  await assert.rejects(
    f.run({
      assertCurrent: async () => {
        if (writesAllowed-- === 0) throw new Error("candidate cleared");
      },
    }),
    /candidate cleared/,
  );
  assert.equal(f.writes.length, 3);
});
test("reconciles a lost accepted response by reading the same Apple submission", async () => {
  const f = fixture({
    version: storeVersion(),
    submission: review("READY_FOR_REVIEW"),
    entries: [versionItem],
    onSubmit: (s) => {
      s.attributes.state = "WAITING_FOR_REVIEW";
      throw new Error("socket timed out");
    },
  });
  assert.deepEqual(await f.run(), {
    id: "review",
    state: "WAITING_FOR_REVIEW",
  });
  assert.deepEqual(f.writes, [["PATCH", "/v1/reviewSubmissions/review"]]);
});
test("returns Apple's metadata error with the recoverable draft instead of replaying submission", async () => {
  const f = fixture({
    version: storeVersion(),
    submission: review("READY_FOR_REVIEW"),
    entries: [versionItem],
    onSubmit: () => {
      throw new Error("HTTP 409: required screenshot");
    },
  });
  await assert.rejects(f.run(), /required screenshot/);
  assert.deepEqual(f.saved, ["review"]);
  assert.deepEqual(f.writes, [["PATCH", "/v1/reviewSubmissions/review"]]);
});
test("returns a completed, approved submission from the saved receipt", async () => {
  const f = fixture({
    version: storeVersion(
      target.appleBuildId,
      "MANUAL",
      "PENDING_DEVELOPER_RELEASE",
    ),
    previous: review("COMPLETE", "prior"),
    previousItems: [versionItem],
  });
  assert.deepEqual(await f.run({ knownSubmissionId: "prior" }), {
    id: "prior",
    state: "COMPLETE",
  });
  assert.deepEqual(f.writes, []);
});

test("does not overwrite a different build selected while the workflow is running", async () => {
  const version = storeVersion(null, "AFTER_APPROVAL");
  const f = fixture({ version });
  await assert.rejects(
    f.run({
      assertCurrent: async () => {
        version.relationships.build = ref("someone-elses-build");
      },
    }),
    /changed before selection/,
  );
  assert.deepEqual(f.writes, []);
});
test("release mode can be corrected without overwriting an existing build relationship", async () => {
  const f = fixture({
    version: storeVersion(target.appleBuildId, "AFTER_APPROVAL"),
  });
  await f.run();
  assert.deepEqual(f.writes[0], ["PATCH", "/v1/appStoreVersions/version"]);
});
test("finds the approved manual submission even when originally submitted outside Actions", async () => {
  const previous = review("COMPLETE", "prior");
  previous.relationships.appStoreVersionForReview = ref("version");
  const f = fixture({
    version: storeVersion(
      target.appleBuildId,
      "MANUAL",
      "PENDING_DEVELOPER_RELEASE",
    ),
    previous,
    previousItems: [versionItem],
  });
  assert.deepEqual(await f.run(), { id: "prior", state: "COMPLETE" });
  assert.deepEqual(f.writes, []);
});
for (const state of ["DEVELOPER_REJECTED", "REJECTED"])
  test(`an explicit retry can submit an editable ${state} version after a resolved or deleted draft`, async () => {
    const f = fixture({
      version: storeVersion(target.appleBuildId, "MANUAL", state),
      previous: state === "REJECTED" ? review("COMPLETE", "old") : undefined,
      previousItems: [{ ...versionItem, attributes: { state: "REJECTED" } }],
    });
    assert.deepEqual(await f.run({ knownSubmissionId: "old" }), {
      id: "review",
      state: "WAITING_FOR_REVIEW",
    });
    assert.equal(
      f.writes.filter(
        ([method, path]) => method === "PATCH" && path.endsWith("/review"),
      ).length,
      1,
    );
  });
