// App Store submission consumes an already verified TestFlight build. No upload,
// public release request, or change to client minimums is part of this operation.
import { setTimeout as sleep } from "node:timers/promises";

const platform = "IOS";
const submitted = new Set([
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "COMPLETING",
  "COMPLETE",
]);
const progressed = new Set([
  "ACCEPTED",
  "IN_REVIEW",
  "WAITING_FOR_REVIEW",
  "PENDING_APPLE_RELEASE",
  "PENDING_DEVELOPER_RELEASE",
  "PROCESSING_FOR_DISTRIBUTION",
  "READY_FOR_DISTRIBUTION",
  "READY_FOR_SALE",
  "REPLACED_WITH_NEW_VERSION",
]);
const editable = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "DEVELOPER_REJECTED",
  "METADATA_REJECTED",
  "REJECTED",
]);

function relationship(type, id) {
  return { data: { type, id } };
}

function id(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]+$/.test(value))
    throw new Error("Missing or invalid Apple resource ID");
  return value;
}

function buildOf(version) {
  const link = version.relationships?.build;
  if (!link || !Object.hasOwn(link, "data"))
    throw new Error("Apple did not return the selected build relationship");
  return link.data === null ? null : id(link.data.id);
}

function versionState(version) {
  return version.attributes.appVersionState ?? version.attributes.appStoreState;
}

export async function submitForReview(
  client,
  request,
  { knownSubmissionId, saveSubmission, assertCurrent },
) {
  const appId = id(request.appId);
  const build = id(request.appleBuildId);
  const versions = await client.list(
    `/v1/apps/${appId}/appStoreVersions?${new URLSearchParams({
      "filter[platform]": platform,
      "filter[versionString]": request.version,
      include: "build",
    })}`,
  );
  if (versions.length > 1) throw new Error("Ambiguous iOS store version");
  let version = versions[0];
  if (
    version &&
    (version.attributes.platform !== platform ||
      version.attributes.versionString !== request.version)
  )
    throw new Error("Unexpected iOS store version");
  if (version && buildOf(version) !== null && buildOf(version) !== build)
    throw new Error(
      `Store version ${request.version} (${versionState(version)}) already selects Apple build ${buildOf(version)}; requested ${build}`,
    );

  const submissions = "/v1/reviewSubmissions";
  const active = await client.list(
    `/v1/apps/${appId}/reviewSubmissions?${new URLSearchParams({
      "filter[platform]": platform,
      "filter[state]":
        "READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,CANCELING,COMPLETING",
    })}`,
  );
  const items = (submissionId) =>
    client.list(
      `${submissions}/${id(submissionId)}/items?include=appStoreVersion&limit=200`,
    );
  const onlyTarget = (entries) =>
    Boolean(version) &&
    entries.length === 1 &&
    !["REMOVED", "REJECTED"].includes(entries[0].attributes?.state) &&
    entries[0].relationships?.appStoreVersion?.data?.id === version.id;
  const readSubmission = async (submissionId) => {
    const { data } = await client.request(
      `${submissions}/${id(submissionId)}?include=app`,
    );
    if (
      data.id !== submissionId ||
      data.relationships?.app?.data?.id !== appId ||
      data.attributes.platform !== platform
    )
      throw new Error("Submission does not belong to this iOS app");
    return data;
  };
  async function readVersion() {
    const { data } = await client.request(
      `/v1/appStoreVersions/${id(version.id)}?include=build`,
    );
    if (
      data.id !== version.id ||
      data.attributes.versionString !== request.version ||
      data.attributes.platform !== platform
    )
      throw new Error("Unexpected iOS store version");
    return data;
  }
  async function verifySelection() {
    const data = await readVersion();
    if (data.attributes.releaseType !== "MANUAL" || buildOf(data) !== build)
      throw new Error("Store release mode or selected build changed");
    return data;
  }

  if (active.length > 1)
    throw new Error(
      "Multiple active iOS submissions; inspect App Store Connect",
    );
  let draft = active[0];
  const entries = draft ? await items(draft.id) : [];
  if (draft) {
    if (draft.attributes.platform !== platform)
      throw new Error("Unexpected review platform");
    if (draft.attributes.state !== "READY_FOR_REVIEW") {
      if (submitted.has(draft.attributes.state) && onlyTarget(entries)) {
        await verifySelection();
        return { id: draft.id, state: draft.attributes.state };
      }
      throw new Error(
        `Resolve active iOS submission ${draft.id} (${draft.attributes.state}) in App Store Connect`,
      );
    }
    if (
      !onlyTarget(entries) &&
      !(entries.length === 0 && draft.id === knownSubmissionId)
    )
      throw new Error(
        `Draft ${draft.id} contains other items or has no verified owner`,
      );
  }
  if (knownSubmissionId && knownSubmissionId !== draft?.id) {
    const previous = await readSubmission(knownSubmissionId).catch((error) => {
      // An operator can discard a draft before explicitly requesting this build again.
      if (error.status !== 404) throw error;
    });
    if (
      previous &&
      submitted.has(previous.attributes.state) &&
      onlyTarget(await items(previous.id)) &&
      version &&
      progressed.has(versionState(version))
    ) {
      await verifySelection();
      return { id: previous.id, state: previous.attributes.state };
    }
    if (previous && previous.attributes.state !== "COMPLETE")
      throw new Error(
        `Inspect previous submission ${previous.id} before continuing`,
      );
  }
  if (version && !draft && progressed.has(versionState(version))) {
    const complete = await client.list(
      `/v1/apps/${appId}/reviewSubmissions?${new URLSearchParams({ "filter[platform]": platform, "filter[state]": "COMPLETE", include: "appStoreVersionForReview" })}`,
    );
    for (const record of complete) {
      if (
        record.attributes.state === "COMPLETE" &&
        record.relationships?.appStoreVersionForReview?.data?.id ===
          version.id &&
        onlyTarget(await items(record.id))
      ) {
        await verifySelection();
        return { id: record.id, state: record.attributes.state };
      }
    }
  }
  if (version && !editable.has(versionState(version)))
    throw new Error(
      `Version is ${versionState(version)}; inspect its existing submission`,
    );

  async function write(path, method, data) {
    await assertCurrent();
    return client.request(path, { method, body: { data } });
  }
  if (!version) {
    ({ data: version } = await write("/v1/appStoreVersions", "POST", {
      type: "appStoreVersions",
      attributes: {
        platform,
        versionString: request.version,
        releaseType: "MANUAL",
      },
      relationships: {
        app: relationship("apps", appId),
        build: relationship("builds", build),
      },
    }));
  } else if (
    buildOf(version) !== build ||
    version.attributes.releaseType !== "MANUAL"
  ) {
    await assertCurrent();
    const fresh = await readVersion();
    const selected = buildOf(fresh);
    if (
      !editable.has(versionState(fresh)) ||
      (selected !== null && selected !== build)
    )
      throw new Error("Store version or build changed before selection");
    const data = { type: "appStoreVersions", id: fresh.id };
    if (fresh.attributes.releaseType !== "MANUAL")
      data.attributes = { releaseType: "MANUAL" };
    if (selected === null)
      data.relationships = { build: relationship("builds", build) };
    if (data.attributes || data.relationships)
      await client.request(`/v1/appStoreVersions/${id(fresh.id)}`, {
        method: "PATCH",
        body: { data },
      });
  }
  version = await verifySelection();
  if (!draft) {
    ({ data: draft } = await write(submissions, "POST", {
      type: "reviewSubmissions",
      attributes: { platform },
      relationships: { app: relationship("apps", appId) },
    }));
  }
  // Persist the Apple ID before attaching an item or asking for review. A lost
  // create response leaves an unowned empty draft, which must be reconciled by a person.
  await saveSubmission(id(draft.id));
  if (!entries.length)
    await write("/v1/reviewSubmissionItems", "POST", {
      type: "reviewSubmissionItems",
      relationships: {
        reviewSubmission: relationship("reviewSubmissions", draft.id),
        appStoreVersion: relationship("appStoreVersions", version.id),
      },
    });

  await assertCurrent();
  const [before, finalItems] = await Promise.all([
    readSubmission(draft.id),
    items(draft.id),
    verifySelection(),
  ]);
  if (!onlyTarget(finalItems) || before.attributes.state !== "READY_FOR_REVIEW")
    throw new Error("Review draft changed before submission");
  let failure;
  try {
    await client.request(`${submissions}/${draft.id}`, {
      method: "PATCH",
      body: {
        data: {
          type: "reviewSubmissions",
          id: draft.id,
          attributes: { submitted: true },
        },
      },
    });
  } catch (error) {
    failure = error;
  }
  // A timeout can mean Apple accepted the request. Only repeat reads.
  for (let attempt = 0; attempt < 3; attempt++) {
    const after = await readSubmission(draft.id);
    if (submitted.has(after.attributes.state)) {
      if (!onlyTarget(await items(after.id)))
        throw new Error("Submitted items differ from the requested version");
      const verified = await verifySelection();
      if (
        after.attributes.state === "COMPLETE" &&
        !progressed.has(versionState(verified))
      )
        throw new Error(
          `Submission ${draft.id} ended with version state ${versionState(verified)}`,
        );
      return { id: after.id, state: after.attributes.state };
    }
    if (after.attributes.state !== "READY_FOR_REVIEW") break;
    if (attempt < 2) await sleep(1000);
  }
  throw (
    failure ??
    new Error(
      `Submission ${draft.id} has not entered review; inspect before retrying`,
    )
  );
}
