import { describe, expect, it } from "vitest";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "../presentation-template-items";
import {
  buildPresentationRunbookInstructionLines,
  findPresentationRunbookPackage,
  findPresentationRunbookResource,
  listPresentationRunbookPackages,
} from "../resource-registry";

describe("presentation runbook packages", () => {
  it("keeps default HTML packages and picker style ids unchanged", () => {
    const packages = listPresentationRunbookPackages();
    expect(packages).toEqual(listPresentationRunbookPackages("html"));
    expect(packages).toHaveLength(23);
    expect(
      packages
        .map((pkg) => {
          return pkg.templateId;
        })
        .sort(),
    ).toEqual(
      PRESENTATION_TEMPLATE_PICKER_ITEMS.map((item) => {
        return item.templateId;
      }).sort(),
    );
    for (const pkg of packages) {
      expect(pkg.outputFormat).toBe("html");
      expect(pkg.resourceId).toBe(`${pkg.templateId}-runbook`);
      expect(pkg.source.archive?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(findPresentationRunbookPackage(pkg.templateId)).toEqual(pkg);
    }
  });

  it("resolves each picker style to an independent native package without a fabricated archive", () => {
    const htmlPackages = listPresentationRunbookPackages("html");
    const pptxPackages = listPresentationRunbookPackages("pptx");
    expect(pptxPackages).toHaveLength(htmlPackages.length + 1);
    for (const htmlPackage of htmlPackages) {
      const pkg = findPresentationRunbookPackage(
        htmlPackage.templateId,
        "pptx",
      );
      if (!pkg) {
        throw new Error(`Missing native style for ${htmlPackage.templateId}`);
      }
      expect(pkg.outputFormat).toBe("pptx");
      expect(pkg.slug).toBe(`${htmlPackage.slug}-native`);
      expect(pkg.resourceId).toBe(`template:pptx-${htmlPackage.slug}-runbook`);
      expect(pkg.source).toEqual({ path: pkg.slug });
      expect(findPresentationRunbookResource(pkg.resourceId)).toMatchObject({
        id: pkg.resourceId,
        kind: "template",
        source: { path: pkg.slug },
      });
    }
    const resourceIds = [...htmlPackages, ...pptxPackages].map((pkg) => {
      return pkg.resourceId;
    });
    expect(new Set(resourceIds).size).toBe(resourceIds.length);
    expect(
      findPresentationRunbookPackage("template:unknown", "pptx"),
    ).toBeUndefined();
    expect(
      findPresentationRunbookResource("template:pptx-unknown-runbook"),
    ).toBeUndefined();
  });

  it("resolves Plain only as a native package", () => {
    expect(
      findPresentationRunbookPackage("template:pptx-plain", "html"),
    ).toBeUndefined();
    expect(
      findPresentationRunbookPackage("template:pptx-plain", "pptx"),
    ).toMatchObject({
      resourceId: "template:pptx-plain-runbook",
      slug: "plain-native",
      defaultColorSystem: "nordic_frost",
    });
    expect(
      findPresentationRunbookResource("template:pptx-plain-runbook"),
    ).toMatchObject({
      id: "template:pptx-plain-runbook",
      source: { path: "plain-native" },
    });
  });

  it.each(["html", "pptx"] as const)(
    "uses the matching %s package directory and authoring workflow",
    (outputFormat) => {
      const pkg = findPresentationRunbookPackage(
        "template:html-ppt-schoolhouse",
        outputFormat,
      );
      if (!pkg) {
        throw new Error(`Missing ${outputFormat} Schoolhouse package`);
      }
      const instructions = buildPresentationRunbookInstructionLines({
        runbookPackage: pkg,
        colorSystemToken: "bauhaus-primary",
        imageGenerationEnabled: false,
      }).join("\n");
      const resourceDir =
        outputFormat === "pptx"
          ? "./generated/resources/pptx"
          : "./generated/resources";
      expect(instructions).toContain(
        `okou resource pull ${pkg.resourceId} --dir ${resourceDir}`,
      );
      const packageDirectory =
        outputFormat === "pptx" ? "schoolhouse-native" : "schoolhouse";
      expect(instructions).toContain(
        `${resourceDir}/${packageDirectory}/SKILL.md`,
      );
      expect(instructions).toContain(
        "If the selected package is unavailable, stop and report it",
      );
      if (outputFormat === "pptx") {
        expect(instructions).toContain(
          "Author an editable native PPTX directly",
        );
        expect(instructions).not.toContain("okou host");
        expect(instructions).not.toContain("index.html");
      } else {
        expect(instructions).toContain(
          "Keep all slides and visible content in index.html",
        );
        expect(instructions).toContain("okou host");
      }
    },
  );
});
