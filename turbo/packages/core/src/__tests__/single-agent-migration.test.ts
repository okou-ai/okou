import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prepareContentBundle, readContentBundle } from "../content-bundle";
import { prepareWorkflowAttachmentBundle } from "../workflow-attachment-bundle";
import {
  STAFF_SINGLE_AGENT_ORG_ID,
  isMigratedWorkflowAttachment,
  readMigratedWorkflowAttachments,
  staffWorkflowCopyId,
} from "../single-agent-migration";

describe("Single Agent Workflow attachment inheritance", () => {
  const sourceId = "81234567-49ab-4ef0-b234-56789abcdef0";
  const uploadId = "80f955fb-ccbd-4a4f-b6f7-69c48246bda9";
  const staffCopyId = "8565fb4c-0d18-541d-89fb-d8a2cfb8f633";
  const inactiveCopyId = "1cf8de92-33c5-5a65-841e-5abfa45c3b6d";

  it("recognizes the staff and inactive migration IDs in their own workspaces", () => {
    expect(staffWorkflowCopyId(sourceId)).toBe(staffCopyId);
    expect(
      isMigratedWorkflowAttachment({
        orgId: STAFF_SINGLE_AGENT_ORG_ID,
        workflowId: staffCopyId,
        objectKey: `workflow-attachments/${STAFF_SINGLE_AGENT_ORG_ID}/${sourceId}/${uploadId}/archive.tar.gz`,
      }),
    ).toBe(true);
    expect(
      isMigratedWorkflowAttachment({
        orgId: "org_inactive",
        workflowId: inactiveCopyId,
        objectKey: `workflow-attachments/org_inactive/${sourceId}/${uploadId}/archive.tar.gz`,
      }),
    ).toBe(true);
  });

  it("rejects unrelated IDs, foreign workspaces, and malformed attachment keys", () => {
    const inactive = {
      orgId: "org_inactive",
      workflowId: inactiveCopyId,
      objectKey: `workflow-attachments/org_inactive/${sourceId}/${uploadId}/archive.tar.gz`,
    };
    const staffKey = inactive.objectKey.replace(
      inactive.orgId,
      STAFF_SINGLE_AGENT_ORG_ID,
    );
    const cases = [
      { ...inactive, workflowId: sourceId },
      { ...inactive, workflowId: staffCopyId },
      { ...inactive, orgId: "org_other" },
      { ...inactive, objectKey: staffKey },
      {
        ...inactive,
        objectKey: inactive.objectKey.replace(sourceId, uploadId),
      },
      {
        ...inactive,
        objectKey: inactive.objectKey.replace(uploadId, "0".repeat(36)),
      },
      {
        ...inactive,
        orgId: STAFF_SINGLE_AGENT_ORG_ID,
        objectKey: staffKey,
      },
    ];
    for (const candidate of cases) {
      expect(isMigratedWorkflowAttachment(candidate)).toBe(false);
    }
  });

  it("republishes binary attachments and executable modes without touching the source archive", async () => {
    const files = [
      { path: "assets/raw.bin", content: Buffer.from([0, 255, 128, 1]) },
      {
        path: "scripts/run.sh",
        content: Buffer.from("#!/bin/sh\necho retained\n"),
        mode: 0o755 as const,
      },
    ];
    const attachment = await prepareWorkflowAttachmentBundle(
      STAFF_SINGLE_AGENT_ORG_ID,
      randomUUID(),
      files,
    );
    if (attachment.descriptor.kind !== "bundle")
      throw new Error("Bundle required");
    const descriptor = attachment.descriptor;
    const original = await prepareContentBundle([
      { path: "SKILL.md", content: Buffer.from("old name and body") },
      ...files,
    ]);
    const before = Buffer.from(original.archive);
    const inherited = readMigratedWorkflowAttachments(
      original.archive,
      original.descriptor,
      descriptor,
    );
    const changed = await prepareContentBundle([
      {
        path: "SKILL.md",
        content: Buffer.from("prefixed name and edited body"),
      },
      ...inherited,
    ]);
    const changedFiles = readContentBundle(changed.archive, changed.descriptor);
    expect(
      changedFiles.filter((file) => {
        return file.path !== "SKILL.md";
      }),
    ).toEqual(inherited);
    expect(
      changedFiles.find((file) => {
        return file.path === "assets/raw.bin";
      })?.content,
    ).toEqual(files[0]!.content);
    expect(
      changedFiles.find((file) => {
        return file.path === "scripts/run.sh";
      })?.mode,
    ).toBe(0o755);
    expect(original.archive).toEqual(before);
    expect(() => {
      return readMigratedWorkflowAttachments(
        changed.archive,
        original.descriptor,
        descriptor,
      );
    }).toThrow("integrity");
    const wrongMetadata = { ...descriptor, files: [] };
    expect(() => {
      return readMigratedWorkflowAttachments(
        original.archive,
        original.descriptor,
        wrongMetadata,
      );
    }).toThrow("metadata");
  });
});
