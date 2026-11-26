import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
} from "@okouai/api-contracts/contracts/workflows";
import { readContentBundle } from "@okouai/core/content-bundle";
import { describe, expect, it } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const app = setupApp({
  context,
  routes: [
    ...workflowsRoutes,
    ...workflowAutomationsRoutes,
    ...chatThreadCreateRoutes,
  ],
});
const headers = { authorization: "Bearer clerk-session" } as const;

interface Member {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

function workspace(): string {
  installWorkflowVolumeS3Fixture(context);
  return `org_${randomUUID()}`;
}

function member(
  orgId: string,
  role: "org:admin" | "org:member" = "org:admin",
): Member {
  return { userId: `user_${randomUUID()}`, orgId, role };
}

function as(actor: Member, role: Member["role"] = actor.role) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId, role);
  return headers;
}

function slug(prefix = "flow"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function collection() {
  return app(workflowsCollectionContract);
}

function detail() {
  return app(workflowsDetailContract);
}

function visibility() {
  return app(workflowVisibilityContract);
}

async function createWorkflow(
  actor: Member,
  body: {
    readonly name: string;
    readonly visibility?: "public" | "private";
    readonly chatThreadId?: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly instruction?: string;
    readonly files?: { path: string; content: string }[];
  },
) {
  const response = await accept(
    collection().create({ headers: as(actor), body }),
    [201],
  );
  return response.body;
}

interface StorageWrite {
  readonly key: string;
  readonly body: Buffer;
}

function attachmentArchives(
  writes: readonly StorageWrite[],
): readonly StorageWrite[] {
  return writes.filter((write) => {
    return write.key.startsWith("workflow-attachments/");
  });
}

/** A NUL-terminated tar header field. */
function tarField(header: Buffer, start: number, end: number): string {
  const field = header.subarray(start, end);
  const terminator = field.indexOf(0);
  return field
    .subarray(0, terminator === -1 ? field.length : terminator)
    .toString("utf8");
}

/** Entry paths of a gzipped tar archive in stored order. */
function archivePaths(archive: Buffer | undefined): readonly string[] {
  if (!archive) {
    throw new Error("Expected an attachment archive");
  }
  const tar = gunzipSync(archive);
  const paths: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const header = tar.subarray(offset, offset + 512);
    const path = tarField(header, 0, 100);
    const size = Number.parseInt(tarField(header, 124, 136).trim(), 8);
    paths.push(path);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
}

function readPackage(
  write: StorageWrite | undefined,
): ReadonlyMap<string, string> {
  const sha256 = /^bundles\/v1\/([a-f0-9]{64})\.tar\.gz$/u.exec(
    write?.key ?? "",
  )?.[1];
  if (!write || !sha256) {
    throw new Error("Expected one published workflow package");
  }
  return new Map(
    readContentBundle(write.body, {
      sha256,
      archiveBytes: write.body.byteLength,
    }).map((file) => {
      return [file.path, file.content.toString("utf8")];
    }),
  );
}

function ownerProfileLookups(userId: string): number {
  return context.mocks.clerk.users.getUser.mock.calls.filter((call) => {
    return call[0] === userId;
  }).length;
}

function mockOwnerProfile(userId: string): void {
  context.mocks.clerk.users.getUser.mockImplementation((id: unknown) => {
    if (id !== userId) {
      return Promise.reject(new Error(`Unexpected owner lookup ${String(id)}`));
    }
    return Promise.resolve({
      id: userId,
      firstName: "Workflow",
      lastName: "Author",
      imageUrl: "https://example.com/author.png",
      primaryEmailAddressId: "email_author",
      emailAddresses: [
        { id: "email_author", emailAddress: "author@example.com" },
      ],
    });
  });
}

describe("workflows", () => {
  it("workflows-019 rejects renaming a private workflow to another same-owner private slug", async () => {
    const admin = member(workspace());
    const existing = slug("private-existing");
    await createWorkflow(admin, { name: existing, visibility: "private" });
    const source = await createWorkflow(admin, {
      name: slug(),
      visibility: "private",
    });

    const renamed = await accept(
      detail().update({
        headers: as(admin),
        params: { workflowId: source.id },
        body: { name: existing },
      }),
      [409],
    );

    expect(renamed.body.error.message).toContain(
      `private workflow named "/${existing}"`,
    );
  });

  it("workflows-001 creates private workflows by default and hides them from other org members", async () => {
    const orgId = workspace();
    const admin = member(orgId);
    const other = member(orgId, "org:member");

    const created = await accept(
      collection().create({
        headers: as(admin),
        body: { name: slug(), displayName: "Default Private" },
      }),
      [201],
    );
    const adminList = await accept(
      collection().list({ headers: as(admin), query: { scope: "workspace" } }),
      [200],
    );
    const otherList = await accept(
      collection().list({ headers: as(other), query: {} }),
      [200],
    );

    expect(created.body).toMatchObject({
      visibility: "private",
      ownerUserId: admin.userId,
      canManage: true,
      canPublish: true,
    });
    expect(
      adminList.body.map((workflow) => {
        return workflow.id;
      }),
    ).toContain(created.body.id);
    expect(
      otherList.body.map((workflow) => {
        return workflow.id;
      }),
    ).not.toContain(created.body.id);
  });

  it("workflows-005 allows the workflow owner to maintain a public workspace workflow", async () => {
    const author = member(workspace());
    const created = await createWorkflow(author, {
      name: slug(),
      visibility: "public",
      instruction: "# original content",
    });
    const maintainer = as(author, "org:member");

    const listed = await accept(
      collection().list({ headers: maintainer, query: {} }),
      [200],
    );
    const before = await accept(
      detail().get({ headers: maintainer, params: { workflowId: created.id } }),
      [200],
    );
    await accept(
      detail().update({
        headers: maintainer,
        params: { workflowId: created.id },
        body: { instruction: "# maintained content" },
      }),
      [200],
    );
    const after = await accept(
      detail().get({ headers: maintainer, params: { workflowId: created.id } }),
      [200],
    );
    const deleted = await detail().delete({
      headers: maintainer,
      params: { workflowId: created.id },
      body: undefined,
    });
    const gone = await detail().get({
      headers: maintainer,
      params: { workflowId: created.id },
    });

    expect(
      listed.body.find((workflow) => {
        return workflow.id === created.id;
      }),
    ).toMatchObject({ canManage: true });
    expect(before.body).toMatchObject({
      ownerUserId: author.userId,
      visibility: "public",
      canManage: true,
      canPublish: false,
    });
    expect(after.body).toMatchObject({
      instruction: "# maintained content",
      ownerUserId: author.userId,
      visibility: "public",
    });
    expect(deleted.status).toBe(204);
    expect(gone.status).toBe(404);
  });

  it("workflows-006 allows the org admin to maintain a public workspace workflow", async () => {
    const orgId = workspace();
    const author = member(orgId);
    const admin = member(orgId);
    const created = await createWorkflow(author, {
      name: slug(),
      visibility: "public",
      instruction: "# original content",
    });

    const listed = await accept(
      collection().list({ headers: as(admin), query: {} }),
      [200],
    );
    const before = await accept(
      detail().get({ headers: as(admin), params: { workflowId: created.id } }),
      [200],
    );
    await accept(
      detail().update({
        headers: as(admin),
        params: { workflowId: created.id },
        body: { instruction: "# maintained content" },
      }),
      [200],
    );
    const after = await accept(
      detail().get({ headers: as(admin), params: { workflowId: created.id } }),
      [200],
    );
    const deleted = await detail().delete({
      headers: as(admin),
      params: { workflowId: created.id },
      body: undefined,
    });
    const gone = await detail().get({
      headers: as(admin),
      params: { workflowId: created.id },
    });

    expect(
      listed.body.find((workflow) => {
        return workflow.id === created.id;
      }),
    ).toMatchObject({ canManage: true });
    expect(before.body).toMatchObject({
      ownerUserId: author.userId,
      visibility: "public",
      canManage: true,
      canPublish: false,
    });
    expect(after.body).toMatchObject({
      instruction: "# maintained content",
      ownerUserId: author.userId,
      visibility: "public",
    });
    expect(deleted.status).toBe(204);
    expect(gone.status).toBe(404);
  });

  it("workflows-007 allows a public workflow owner to withdraw sharing without gaining publication rights", async () => {
    const orgId = workspace();
    const author = member(orgId);
    const admin = member(orgId);
    const created = await createWorkflow(author, {
      name: slug(),
      visibility: "public",
    });

    const demoted = await accept(
      visibility().demote({
        headers: as(author, "org:member"),
        params: { workflowId: created.id },
        body: undefined,
      }),
      [200],
    );
    const republished = await visibility().publish({
      headers: as(author, "org:member"),
      params: { workflowId: created.id },
      body: undefined,
    });
    const adminRead = await detail().get({
      headers: as(admin),
      params: { workflowId: created.id },
    });

    expect(demoted.body).toMatchObject({
      visibility: "private",
      ownerUserId: author.userId,
      canManage: true,
      canPublish: false,
    });
    expect(republished.status).toBe(403);
    expect(adminRead.status).toBe(404);
  });

  it("workflows-010 protects public workflow slugs while allowing private overrides", async () => {
    const admin = member(workspace());
    const foreign = member(`org_${randomUUID()}`);
    const name = slug("x");
    const publicWorkflow = await createWorkflow(admin, {
      name,
      visibility: "public",
    });
    const privateWorkflow = await createWorkflow(admin, {
      name,
      visibility: "private",
      displayName: "Private Workflow",
    });
    const foreignWorkflow = await createWorkflow(foreign, {
      name,
      visibility: "public",
    });

    const duplicate = await accept(
      collection().create({
        headers: as(admin),
        body: { name, visibility: "public" },
      }),
      [409],
    );
    const listed = await accept(
      collection().list({ headers: as(admin), query: {} }),
      [200],
    );

    expect(duplicate.body.error.message).toContain(
      `/${name}" already exists in this workspace`,
    );
    const byId = new Map(
      listed.body.map((workflow) => {
        return [workflow.id, workflow];
      }),
    );
    expect(byId.get(publicWorkflow.id)?.shadowedBy).toStrictEqual({
      id: privateWorkflow.id,
      name,
      displayName: "Private Workflow",
    });
    expect(byId.get(privateWorkflow.id)?.shadowedBy).toBeNull();
    expect(byId.has(foreignWorkflow.id)).toBeFalsy();
  });

  it("workflows-011 lists unshadowed workspace workflows with composer fields", async () => {
    const admin = member(workspace());
    const foreign = member(`org_${randomUUID()}`);
    const name = slug("x");
    await createWorkflow(admin, { name, visibility: "public" });
    const privateWorkflow = await createWorkflow(admin, {
      name,
      visibility: "private",
      displayName: "Private Workflow",
      description: "Private override",
    });
    await createWorkflow(foreign, { name: slug(), visibility: "public" });

    const composer = await accept(
      collection().composer({ headers: as(admin), query: {} }),
      [200],
    );

    expect(composer.body).toStrictEqual([
      {
        id: privateWorkflow.id,
        name,
        displayName: "Private Workflow",
        description: "Private override",
      },
    ]);
  });

  it("workflows-012 rejects same-owner private workflow slugs while allowing other-owner private slugs", async () => {
    const orgId = workspace();
    const admin = member(orgId);
    const other = member(orgId, "org:member");
    const name = slug("x");
    await createWorkflow(admin, { name, visibility: "private" });

    const duplicate = await accept(
      collection().create({
        headers: as(admin),
        body: { name, visibility: "private" },
      }),
      [409],
    );
    const otherCreated = await accept(
      collection().create({
        headers: as(other),
        body: { name, visibility: "private" },
      }),
      [201],
    );

    expect(duplicate.body.error.message).toContain(
      `private workflow named "/${name}"`,
    );
    expect(otherCreated.body).toMatchObject({
      name,
      ownerUserId: other.userId,
      visibility: "private",
    });
  });

  it("workflows-018 renames workflow slugs through metadata update and rejects duplicate public slugs", async () => {
    const admin = member(workspace());
    const existing = slug("existing");
    await createWorkflow(admin, { name: existing, visibility: "public" });
    const source = await createWorkflow(admin, {
      name: slug("rename-source"),
      visibility: "public",
      displayName: "Rename Source",
    });
    const renamedName = slug("renamed");

    const renamed = await accept(
      detail().update({
        headers: as(admin),
        params: { workflowId: source.id },
        body: {
          name: renamedName,
          displayName: "Renamed Workflow",
          description: "Renamed description",
        },
      }),
      [200],
    );
    const duplicate = await accept(
      detail().update({
        headers: as(admin),
        params: { workflowId: source.id },
        body: { name: existing },
      }),
      [409],
    );

    expect(renamed.body).toMatchObject({
      name: renamedName,
      displayName: "Renamed Workflow",
      description: "Renamed description",
    });
    expect(duplicate.body.error.message).toContain(
      `/${existing}" already exists in this workspace`,
    );
  });

  it("workflows-020 rejects publishing a private workflow when the public slug is already taken", async () => {
    const admin = member(workspace());
    const name = slug("x");
    await createWorkflow(admin, { name, visibility: "public" });
    const privateWorkflow = await createWorkflow(admin, {
      name,
      visibility: "private",
    });

    const published = await accept(
      visibility().publish({
        headers: as(admin),
        params: { workflowId: privateWorkflow.id },
        body: undefined,
      }),
      [409],
    );

    expect(published.body.error.message).toContain(
      `/${name}" already exists in this workspace`,
    );
  });

  it("workflows-026 makes a deleted Workflow unavailable for reading, editing and publishing", async () => {
    const admin = member(workspace());
    const files = [{ path: "owned.txt", content: "owned attachment" }];
    const created = await createWorkflow(admin, {
      name: slug(),
      visibility: "private",
      files,
    });
    const before = await accept(
      detail().get({ headers: as(admin), params: { workflowId: created.id } }),
      [200],
    );
    expect(before.body.fileContents).toStrictEqual(files);

    const deleted = await detail().delete({
      headers: as(admin),
      params: { workflowId: created.id },
      body: undefined,
    });
    const read = await accept(
      detail().get({ headers: as(admin), params: { workflowId: created.id } }),
      [404],
    );
    const updated = await detail().update({
      headers: as(admin),
      params: { workflowId: created.id },
      body: { instruction: "edited after deletion" },
    });
    const published = await visibility().publish({
      headers: as(admin),
      params: { workflowId: created.id },
      body: undefined,
    });

    expect(deleted.status).toBe(204);
    expect(read.body.error.code).toBe("NOT_FOUND");
    expect(updated.status).toBe(404);
    expect(published.status).toBe(404);
  });

  it("workflows-027 rejects copying a workflow when the caller already has that private slug in the workspace", async () => {
    const admin = member(workspace());
    const name = slug("x");
    const publicWorkflow = await createWorkflow(admin, {
      name,
      visibility: "public",
    });
    await createWorkflow(admin, { name, visibility: "private" });

    const copied = await accept(
      detail().copy({
        headers: as(admin),
        params: { workflowId: publicWorkflow.id },
        body: {},
      }),
      [409],
    );

    expect(copied.body.error.message).toContain(
      `private workflow named "/${name}"`,
    );
  });

  it("workflows-029 rejects demoting a public workflow when the owner already has that private slug", async () => {
    const admin = member(workspace());
    const name = slug("x");
    await createWorkflow(admin, { name, visibility: "private" });
    const publicWorkflow = await createWorkflow(admin, {
      name,
      visibility: "public",
    });

    const demoted = await accept(
      visibility().demote({
        headers: as(admin),
        params: { workflowId: publicWorkflow.id },
        body: undefined,
      }),
      [409],
    );

    expect(demoted.body.error.message).toContain(
      `private workflow named "/${name}"`,
    );
  });

  it("workflows-038 reads and updates workflow content, audit metadata, and deletion through API responses", async () => {
    const orgId = workspace();
    const creator = member(orgId);
    const updater = member(orgId);
    const created = await createWorkflow(creator, {
      name: slug(),
      visibility: "public",
      displayName: "Audit Workflow",
      instruction: "Audit the notes",
      files: [{ path: "notes.md", content: "first notes" }],
    });

    const initial = await accept(
      detail().get({
        headers: as(creator),
        params: { workflowId: created.id },
      }),
      [200],
    );
    const updated = await accept(
      detail().update({
        headers: as(updater),
        params: { workflowId: created.id },
        body: {
          displayName: "Audited Workflow",
          instruction: "Audit the revised notes",
          files: [{ path: "notes.md", content: "revised notes" }],
        },
      }),
      [200],
    );
    const deleted = await detail().delete({
      headers: as(updater),
      params: { workflowId: created.id },
      body: undefined,
    });
    const gone = await accept(
      detail().get({
        headers: as(creator),
        params: { workflowId: created.id },
      }),
      [404],
    );

    expect(initial.body).toMatchObject({
      createdByUserId: creator.userId,
      updatedByUserId: creator.userId,
      ownerUserId: creator.userId,
      instruction: "Audit the notes",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(updated.body).toMatchObject({
      createdByUserId: creator.userId,
      updatedByUserId: updater.userId,
      displayName: "Audited Workflow",
      instruction: "Audit the revised notes",
    });
    expect(deleted.status).toBe(204);
    expect(gone.body.error.code).toBe("NOT_FOUND");
  });

  it("workflows-008 binds a newly created workflow only to the member’s own chat thread", async () => {
    const orgId = workspace();
    const admin = member(orgId);
    const peer = member(orgId, "org:member");
    const thread = await accept(
      app(chatThreadsContract).create({
        headers: as(admin),
        body: { title: "Source chat", model: null },
      }),
      [201],
    );
    const topic = `chatThreadWorkflowsChanged:${thread.body.id}`;

    const adminWorkflow = await createWorkflow(admin, {
      name: slug(),
      chatThreadId: thread.body.id,
    });
    await flushWaitUntilForTest();
    const adminChannels = channelsPublishedTo(context.mocks, topic);
    const adminPrepared = await accept(
      detail().chatThread({
        headers: as(admin),
        params: { workflowId: adminWorkflow.id },
        body: undefined,
      }),
      [200],
    );
    const peerWorkflow = await createWorkflow(peer, {
      name: slug(),
      chatThreadId: thread.body.id,
    });
    await flushWaitUntilForTest();
    const peerPrepared = await accept(
      detail().chatThread({
        headers: as(peer),
        params: { workflowId: peerWorkflow.id },
        body: undefined,
      }),
      [200],
    );

    expect(adminChannels).toStrictEqual([`user:${admin.userId}`]);
    expect(adminPrepared.body.chatThreadId).toBe(thread.body.id);
    expect(adminPrepared.body.prompt).toContain(adminWorkflow.id);
    expect(peerPrepared.body.chatThreadId).not.toBe(thread.body.id);
    expect(channelsPublishedTo(context.mocks, topic)).toStrictEqual(
      adminChannels,
    );
  });

  it("workflows-031 copies schedule-only workflows without binding a chat thread", async () => {
    const admin = member(workspace());
    const source = await createWorkflow(admin, {
      name: slug(),
      visibility: "public",
    });
    const automations = app(workflowAutomationsContract);
    await accept(
      automations.create({
        headers: as(admin),
        params: { workflowId: source.id },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 900 },
        },
      }),
      [201],
    );

    const copied = await accept(
      detail().copy({
        headers: as(admin),
        params: { workflowId: source.id },
        body: {},
      }),
      [201],
    );
    const copiedAutomations = await accept(
      automations.list({
        headers: as(admin),
        params: { workflowId: copied.body.id },
      }),
      [200],
    );

    expect(copiedAutomations.body).toHaveLength(1);
    expect(copiedAutomations.body[0]).toMatchObject({
      kind: "schedule",
      chatThreadId: null,
    });
  });
});

describe("workflow attachments", () => {
  it("workflows-036 reuses current attachment bytes across body edits and file ordering, and never reactivates retired packages", async () => {
    const admin = member(`org_${randomUUID()}`);
    const storage = installWorkflowVolumeS3Fixture(context);
    const files = [
      { path: "zeta.txt", content: "附件" },
      { path: "alpha.txt", content: "alpha" },
    ];
    const created = await createWorkflow(admin, {
      name: slug(),
      instruction: "first body",
      files,
    });
    const createdArchives = attachmentArchives(storage.writes);
    expect(createdArchives).toHaveLength(1);
    expect(archivePaths(createdArchives[0]?.body)).toStrictEqual([
      "alpha.txt",
      "zeta.txt",
    ]);

    storage.clearWrites();
    const edited = await accept(
      detail().update({
        headers: as(admin),
        params: { workflowId: created.id },
        body: { instruction: "second body" },
      }),
      [200],
    );
    const editWrites = [...storage.writes];
    storage.clearWrites();
    await accept(
      detail().update({
        headers: as(admin),
        params: { workflowId: created.id },
        body: { files: [...files].reverse() },
      }),
      [200],
    );
    const reorderedArchives = attachmentArchives(storage.writes);
    await accept(
      detail().update({
        headers: as(admin),
        params: { workflowId: created.id },
        body: { files: [] },
      }),
      [200],
    );
    storage.clearWrites();
    await accept(
      detail().update({
        headers: as(admin),
        params: { workflowId: created.id },
        body: { files },
      }),
      [200],
    );
    const readdedArchives = attachmentArchives(storage.writes);
    const read = await accept(
      detail().get({ headers: as(admin), params: { workflowId: created.id } }),
      [200],
    );

    expect(edited.body).toMatchObject({
      instruction: "second body",
      fileContents: null,
      files: [
        { path: "alpha.txt", size: 5 },
        { path: "zeta.txt", size: 6 },
      ],
    });
    expect(attachmentArchives(editWrites)).toHaveLength(0);
    const packages = editWrites.filter((write) => {
      return write.key.startsWith("bundles/v1/");
    });
    expect(packages).toHaveLength(1);
    const packaged = readPackage(packages[0]);
    expect(packaged.get("SKILL.md")).toContain("second body");
    expect(packaged.get("alpha.txt")).toBe("alpha");
    expect(packaged.get("zeta.txt")).toBe("附件");
    expect(reorderedArchives).toHaveLength(0);
    expect(readdedArchives).toHaveLength(1);
    expect(readdedArchives[0]?.key).not.toBe(createdArchives[0]?.key);
    expect(read.body.fileContents).toStrictEqual([
      { path: "alpha.txt", content: "alpha" },
      { path: "zeta.txt", content: "附件" },
    ]);
  });
});

describe("workflow owner profiles", () => {
  it("workflows-040 authorizes each profile read including warm-cache private and cross-org misses", async () => {
    const orgId = workspace();
    const owner = member(orgId);
    const otherAdmin = member(orgId);
    const outsider = member(`org_${randomUUID()}`);
    const created = await createWorkflow(owner, {
      name: slug(),
      visibility: "private",
    });
    mockNow(now() + 16 * 60 * 1000);
    mockOwnerProfile(owner.userId);

    const ownerRead = await accept(
      detail().ownerProfile({
        headers: as(owner),
        params: { workflowId: created.id },
      }),
      [200],
    );
    const lookupsAfterOwner = ownerProfileLookups(owner.userId);
    const otherAdminRead = await detail().ownerProfile({
      headers: as(otherAdmin),
      params: { workflowId: created.id },
    });
    const outsiderRead = await detail().ownerProfile({
      headers: as(outsider),
      params: { workflowId: created.id },
    });
    const unknownRead = await detail().ownerProfile({
      headers: as(owner),
      params: { workflowId: randomUUID() },
    });
    const anonymousRead = await detail().ownerProfile({
      headers: {},
      params: { workflowId: created.id },
    });

    expect(ownerRead.body).toStrictEqual({
      displayName: "Workflow Author",
      imageUrl: "https://example.com/author.png",
    });
    expect(otherAdminRead.status).toBe(404);
    expect(outsiderRead.status).toBe(404);
    expect(unknownRead.status).toBe(404);
    expect(anonymousRead.status).toBe(401);
    expect(lookupsAfterOwner).toBe(1);
    expect(ownerProfileLookups(owner.userId)).toBe(1);
  });

  it("workflows-041 does not disclose a workflow profile after sharing is withdrawn", async () => {
    const orgId = workspace();
    const owner = member(orgId);
    const viewer = member(orgId, "org:member");
    const created = await createWorkflow(owner, {
      name: slug(),
      visibility: "public",
    });
    mockNow(now() + 16 * 60 * 1000);
    mockOwnerProfile(owner.userId);

    const first = await detail().ownerProfile({
      headers: as(viewer),
      params: { workflowId: created.id },
    });
    const lookupsAfterFirst = ownerProfileLookups(owner.userId);
    const demoted = await visibility().demote({
      headers: as(owner),
      params: { workflowId: created.id },
      body: undefined,
    });
    const second = await detail().ownerProfile({
      headers: as(viewer),
      params: { workflowId: created.id },
    });

    expect(first.status).toBe(200);
    expect(demoted.status).toBe(200);
    expect(second.status).toBe(404);
    expect(ownerProfileLookups(owner.userId)).toBe(lookupsAfterFirst);
  });
});
