import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";

const context = testContext();
const bdd = createBddApi(context);
const host = createHostBddApi(context);

function siteFile(path: string, content: string) {
  return {
    path,
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    contentType: "text/html; charset=utf-8",
  };
}

describe("artifact downloads", () => {
  it("artifact-downloads-007 lets an outsider list a public site's files for cloning", async () => {
    host.captureHostedSitesS3();
    const owner = bdd.user();
    const outsider = bdd.user({ orgId: null });
    const files = [
      siteFile("/index.html", "<h1>Home</h1>"),
      siteFile("/about.html", "<h1>About</h1>"),
      siteFile("/notes.html", "<p>Release notes</p>"),
      siteFile("/docs/guide.html", "<h1>Guide</h1>"),
      siteFile("/docs/faq.html", "<p>Questions</p>"),
    ];
    const prepared = await host.prepareHostedSite(owner, {
      site: `site-${randomUUID().slice(0, 8)}`,
      title: "Public handbook",
      visibility: "public",
      artifactKind: "hosted-site",
      spaFallback: false,
      files,
    });
    await host.completeHostedSite(owner, prepared.deploymentId);

    const deploymentSlug = `dpl-${prepared.deploymentId}`;
    for (const slug of [prepared.publicSlug, deploymentSlug]) {
      const listed = await host.readHostedSiteFiles(outsider, slug);
      expect(listed.deploymentId).toBe(prepared.deploymentId);
      expect(listed.fileCount).toBe(5);
      expect(listed.size).toBe(
        files.reduce((total, file) => {
          return total + file.size;
        }, 0),
      );
      expect(
        listed.files.map((file) => {
          return file.path;
        }),
      ).toStrictEqual(
        expect.arrayContaining(
          files.map((file) => {
            return file.path;
          }),
        ),
      );
      for (const file of listed.files) {
        const url = new URL(file.downloadUrl);
        expect(url.hostname).toBe(`${deploymentSlug}.okou.app`);
        expect(url.pathname.startsWith("/.okou/download/")).toBeTruthy();
        expect(url.searchParams.get("path")).toBe(file.path);
      }
    }
  });
});
