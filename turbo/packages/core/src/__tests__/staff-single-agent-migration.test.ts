import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { uuid } from "zod";
import { prepareContentBundle, readContentBundle } from "../content-bundle";
import { prepareWorkflowAttachmentBundle } from "../workflow-attachment-bundle";
import {
  STAFF_SINGLE_AGENT_ORG_ID,
  isStaffCopiedAttachment,
  readStaffCopiedAttachments,
  staffWorkflowCopyId,
} from "../staff-single-agent-migration";

describe("temporary staff Workflow copies", () => {
  it("recognizes only the exact staff source-to-copy attachment relationship", async () => {
    const source = randomUUID();
    const upload = await prepareWorkflowAttachmentBundle(
      STAFF_SINGLE_AGENT_ORG_ID,
      source,
      [{ path: "reference.txt", content: Buffer.from("reference") }],
    );
    expect(upload.descriptor.kind).toBe("bundle");
    if (upload.descriptor.kind !== "bundle") throw new Error("Bundle required");
    const input = {
      orgId: STAFF_SINGLE_AGENT_ORG_ID,
      workflowId: uuid().parse(staffWorkflowCopyId(source)),
      objectKey: upload.descriptor.objectKey,
    };
    expect(isStaffCopiedAttachment(input)).toBe(true);
    expect(isStaffCopiedAttachment({ ...input, workflowId: source })).toBe(
      false,
    );
    expect(
      isStaffCopiedAttachment({ ...input, workflowId: randomUUID() }),
    ).toBe(false);
    expect(isStaffCopiedAttachment({ ...input, orgId: "foreign" })).toBe(false);
    expect(
      isStaffCopiedAttachment({
        ...input,
        objectKey: input.objectKey.replace(source, randomUUID()),
      }),
    ).toBe(false);
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
    const inherited = readStaffCopiedAttachments(
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
      return readStaffCopiedAttachments(
        changed.archive,
        original.descriptor,
        descriptor,
      );
    }).toThrow("integrity");
    const wrongMetadata = { ...descriptor, files: [] };
    expect(() => {
      return readStaffCopiedAttachments(
        original.archive,
        original.descriptor,
        wrongMetadata,
      );
    }).toThrow("metadata");
  });
});
