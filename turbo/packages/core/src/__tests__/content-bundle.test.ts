import { describe, expect, it } from "vitest";
import {
  prepareContentBundle,
  readContentBundle,
  contentBundleKey,
} from "../content-bundle";

describe("content-addressed input bundles", () => {
  it("uses identical complete archive bytes for reordered files across owners", async () => {
    const files = [
      {
        path: "SKILL.md",
        content: Buffer.from("---\nname: example\n---\n中文\n"),
      },
      { path: "references/binary.bin", content: Buffer.from([0, 255, 1, 128]) },
      {
        path: `references/${["目录".repeat(30), "目录".repeat(30), "目录".repeat(30)].join("/")}/raw.bin`,
        content: Buffer.from([0, 255, 128, 1]),
      },
    ];
    const first = await prepareContentBundle(files);
    const second = await prepareContentBundle([...files].reverse());
    expect(second).toEqual(first);
    expect(readContentBundle(first.archive, first.descriptor)).toEqual(files);
    expect(contentBundleKey(first.descriptor.sha256)).toBe(
      `bundles/v1/${first.descriptor.sha256}.tar.gz`,
    );
    const changed = await prepareContentBundle([
      { ...files[0]!, content: Buffer.from("changed") },
      ...files.slice(1),
    ]);
    expect(changed.descriptor.sha256).not.toBe(first.descriptor.sha256);
  });
  it("preserves empty instructions and raw large Unicode/whitespace bodies", async () => {
    for (const content of [
      Buffer.alloc(0),
      Buffer.from("\uFEFF \r\n正文".repeat(180000)),
    ]) {
      const bundle = await prepareContentBundle([
        { path: "instructions.md", content },
      ]);
      const files = readContentBundle(bundle.archive, bundle.descriptor);
      expect(
        files.map((file) => {
          return file.path;
        }),
      ).toEqual(["instructions.md"]);
      expect(files[0]!.content.equals(content)).toBe(true);
    }
  });
  it("rejects corrupt bytes and ambiguous archive paths before publication", async () => {
    const bundle = await prepareContentBundle([
      { path: "SKILL.md", content: Buffer.from("skill") },
    ]);
    const corrupt = Buffer.from(bundle.archive);
    corrupt[10] = (corrupt[10] ?? 0) ^ 1;
    expect(() => {
      return readContentBundle(corrupt, bundle.descriptor);
    }).toThrow("integrity");
    for (const paths of [
      ["../outside"],
      ["./SKILL.md"],
      ["a", "a/b"],
      ["SKILL.md", "SKILL.md"],
    ]) {
      await expect(
        prepareContentBundle(
          paths.map((path) => {
            return { path, content: Buffer.from("x") };
          }),
        ),
      ).rejects.toThrow();
    }
  });
});
