import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  prepareWorkflowAttachmentBundle,
  verifyWorkflowAttachmentBundle,
} from "../workflow-attachment-bundle";

describe("Workflow attachment packages", () => {
  it("preserves nested text and binary bytes with stable content identity and independently owned immutable objects", async () => {
    const id = randomUUID();
    const files = [
      { path: "references/参考.md", content: Buffer.from("  内容\n\n") },
      { path: "scripts/data.bin", content: Buffer.from([0, 255, 128, 10]) },
    ];
    const first = await prepareWorkflowAttachmentBundle("org_test", id, files);
    const second = await prepareWorkflowAttachmentBundle(
      "org_test",
      id,
      [...files].reverse(),
    );
    if (
      first.descriptor.kind !== "bundle" ||
      second.descriptor.kind !== "bundle" ||
      first.archive === null
    )
      throw new Error("Expected attachment packages");
    expect(
      verifyWorkflowAttachmentBundle(first.archive, first.descriptor),
    ).toEqual(files);
    expect(second.descriptor.contentHash).toBe(first.descriptor.contentHash);
    expect(second.descriptor.objectKey).not.toBe(first.descriptor.objectKey);
  });
  it("represents empty attachments without an object and rejects ambiguous file ownership", async () => {
    expect(
      await prepareWorkflowAttachmentBundle("org_test", randomUUID(), []),
    ).toEqual({ descriptor: { kind: "empty" }, archive: null });
    for (const paths of [["./SKILL.md"], ["a", "a/b"], ["../outside"]]) {
      await expect(
        prepareWorkflowAttachmentBundle(
          "org_test",
          randomUUID(),
          paths.map((path) => {
            return { path, content: Buffer.from("content") };
          }),
        ),
      ).rejects.toThrow();
    }
  });
  it("matches the legacy encoder's canonical duplicate-path materialization", async () => {
    const id = randomUUID();
    const files = [
      { path: "duplicate.txt", content: Buffer.from("first duplicate") },
      { path: "duplicate.txt", content: Buffer.from("second duplicate") },
    ];
    const first = await prepareWorkflowAttachmentBundle("org_test", id, files);
    const reordered = await prepareWorkflowAttachmentBundle(
      "org_test",
      id,
      [...files].reverse(),
    );
    if (
      first.descriptor.kind !== "bundle" ||
      reordered.descriptor.kind !== "bundle" ||
      first.archive === null
    )
      throw new Error("Expected attachment packages");
    expect(
      verifyWorkflowAttachmentBundle(first.archive, first.descriptor),
    ).toEqual([
      { path: "duplicate.txt", content: Buffer.from("second duplicate") },
    ]);
    expect(first.descriptor.contentHash).toBe(reordered.descriptor.contentHash);
  });
});
