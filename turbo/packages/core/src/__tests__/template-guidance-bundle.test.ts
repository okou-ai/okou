import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import {
  storedTemplateGuidanceBundleSchema,
  templateGuidanceBundleSchema,
  templateGuidanceMountPath,
} from "@okouai/api-contracts/contracts/template-guidance-bundle";
import {
  prepareTemplateGuidanceBundle,
  readTemplateGuidanceBundle,
} from "../template-guidance-bundle";

describe("template guidance bundles", () => {
  it("reads the exact canonical PAX fixture consumed by the native Guest", async () => {
    const directory = new URL(
      "../../../../../crates/guest-storage-apply/tests/fixtures/",
      import.meta.url,
    );
    const archive = await readFile(
      new URL("template-guidance-v1.tar.gz", directory),
    );
    const reference = JSON.parse(
      await readFile(new URL("template-guidance-v1.json", directory), "utf8"),
    ) as unknown;
    const descriptor = templateGuidanceBundleSchema.parse(reference);
    const files = readTemplateGuidanceBundle(archive, descriptor);
    expect(
      files.map((file) => {
        return file.mode;
      }),
    ).toEqual([0o644, 0o644, 0o644]);
    expect(files.at(-1)?.content.equals(Buffer.from([0, 255, 128, 1]))).toBe(
      true,
    );
  });
  it("preserves long paths, bytes and existing 0644 modes with deterministic archives", async () => {
    const path =
      Array.from({ length: 12 }, (_, index) => {
        return `directory-${index}-with-assets`;
      }).join("/") + "/binary.bin";
    expect(path.length).toBeGreaterThan(256);
    const files = [
      { path: "GUIDE.md", content: Buffer.from("guidance\n") },
      { path, content: Buffer.from([0, 255, 128, 1]) },
    ];
    const first = await prepareTemplateGuidanceBundle(files);
    const reordered = await prepareTemplateGuidanceBundle([...files].reverse());
    expect(reordered).toEqual(first);
    expect(readTemplateGuidanceBundle(first.archive, first.descriptor)).toEqual(
      files.map((file) => {
        return { ...file, mode: 0o644 };
      }),
    );
  });

  it("carries legitimate templates larger than the Skill archive and content limits", async () => {
    const files = ["a.bin", "b.bin"].map((path) => {
      return {
        path,
        content: randomBytes(17 * 1024 * 1024),
      };
    });
    const bundle = await prepareTemplateGuidanceBundle(files);
    expect(bundle.archive.length).toBeGreaterThan(32 * 1024 * 1024);
    expect(contentBundleSchema.safeParse(bundle.descriptor).success).toBe(
      false,
    );
    const decoded = readTemplateGuidanceBundle(
      bundle.archive,
      bundle.descriptor,
    );
    expect(
      decoded.map((file) => {
        return {
          path: file.path,
          bytes: file.content.length,
          mode: file.mode,
        };
      }),
    ).toEqual(
      files.map((file) => {
        return {
          path: file.path,
          bytes: file.content.length,
          mode: 0o644,
        };
      }),
    );
    for (const [index, file] of files.entries())
      expect(decoded[index]!.content.equals(file.content)).toBe(true);
  });

  it("keeps canonical tar overhead bounded for 200 deep paths", async () => {
    const prefix = Array.from({ length: 14 }, () => {
      return "a".repeat(250);
    }).join("/");
    const files = Array.from({ length: 200 }, (_, index) => {
      return {
        path: `${prefix}/file-${index}.bin`,
        content: Buffer.alloc(512 * 1024),
      };
    });
    const bundle = await prepareTemplateGuidanceBundle(files);
    const tar = gunzipSync(bundle.archive);
    expect(tar.length).toBeLessThan(102 * 1024 * 1024);
    expect(
      readTemplateGuidanceBundle(bundle.archive, bundle.descriptor),
    ).toHaveLength(200);
  });

  it("rejects corruption, oversize files, ambiguous paths and package overflow", async () => {
    const bundle = await prepareTemplateGuidanceBundle([
      { path: "GUIDE.md", content: Buffer.from("guidance") },
    ]);
    expect(() => {
      return readTemplateGuidanceBundle(bundle.archive, {
        ...bundle.descriptor,
        archiveBytes: bundle.archive.length + 1,
      });
    }).toThrow("integrity");
    expect(() => {
      return readTemplateGuidanceBundle(bundle.archive, {
        ...bundle.descriptor,
        sha256: "0".repeat(64),
      });
    }).toThrow("integrity");
    for (const paths of [
      ["../escape"],
      ["/escape"],
      ["a\\b"],
      ["a", "a/file"],
      ["a", "a"],
      ["./a"],
    ]) {
      await expect(
        prepareTemplateGuidanceBundle(
          paths.map((path) => {
            return { path, content: Buffer.from("x") };
          }),
        ),
      ).rejects.toThrow();
    }
    await expect(
      prepareTemplateGuidanceBundle([
        { path: "a", content: Buffer.alloc(25 * 1024 * 1024 + 1) },
      ]),
    ).rejects.toThrow("file");
    const content = Buffer.alloc(20 * 1024 * 1024);
    await expect(
      prepareTemplateGuidanceBundle(
        Array.from({ length: 6 }, (_, n) => {
          return { path: `${n}.bin`, content };
        }),
      ),
    ).rejects.toThrow("content limit");
    await expect(
      prepareTemplateGuidanceBundle(
        Array.from({ length: 201 }, (_, n) => {
          return {
            path: `${n}.txt`,
            content: Buffer.alloc(0),
          };
        }),
      ),
    ).rejects.toThrow("file limit");
  });

  it("separates the two owner namespaces and derives only fixed template directories", () => {
    const templateId = "859550cb-28ad-47ef-8728-f6b3849f8c55";
    const reference = {
      sha256: "a".repeat(64),
      archiveBytes: 40 * 1024 * 1024,
      templateId,
      beforeMountPaths: [],
    };
    const current = storedTemplateGuidanceBundleSchema.parse({
      ...reference,
      ownerKind: "user-template",
    });
    const old = storedTemplateGuidanceBundleSchema.parse({
      ...reference,
      ownerKind: "presentation-template",
    });
    expect(templateGuidanceMountPath(current)).toBe(
      `/home/user/workspace/generated/user-template/${templateId}`,
    );
    expect(templateGuidanceMountPath(old)).toBe(
      `/home/user/workspace/generated/presentation-template/${templateId}`,
    );
    expect(
      storedTemplateGuidanceBundleSchema.safeParse({
        ...current,
        templateId: "../../escape",
      }).success,
    ).toBe(false);
    expect(
      storedTemplateGuidanceBundleSchema.safeParse({
        ...current,
        mountPath: "/other",
      }).success,
    ).toBe(false);
  });
});
