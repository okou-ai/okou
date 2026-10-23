import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  hostContract,
  type HostedSiteFilesResponse,
} from "@okouai/api-contracts/contracts/host";
import { waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { strToU8, unzipSync } from "fflate";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const deploymentId = "00000000-0000-4000-8000-000000000041";
const source = "https://weekly-report.okou.app/";
const deployment = `https://dpl-${deploymentId}.okou.app/`;
const members = Object.freeze([
  {
    path: "/index.html",
    contentType: "text/html",
    text: "<h1>Quarterly review</h1>",
  },
  { path: "/site.css", contentType: "text/css", text: "h1 { color: teal }" },
]);

function mockPublication(privateGrant: boolean, single = false) {
  const selected = single ? members.slice(0, 1) : members;
  const grant = new URL(`/.okou/download/${"a".repeat(48)}`, deployment);
  const site: HostedSiteFilesResponse = {
    siteId: "00000000-0000-4000-8000-000000000042",
    deploymentId,
    publicSlug: "weekly-report",
    url: source,
    artifactUrl: deployment,
    fileCount: selected.length,
    size: selected.reduce((size, member) => {
      return size + strToU8(member.text).length;
    }, 0),
    files: selected.map((member) => {
      const url = new URL(grant);
      url.searchParams.set("path", member.path);
      return {
        path: member.path,
        contentType: member.contentType,
        size: strToU8(member.text).length,
        sha256: "a".repeat(64),
        downloadUrl: privateGrant
          ? url.href
          : `https://storage.example.test${member.path}?download=1`,
      };
    }),
  };
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });
  context.mocks.api(hostContract.files, ({ params, query, respond }) => {
    expect(params.publicSlug).toBe("weekly-report");
    expect(query.hostname).toBe("weekly-report.okou.app");
    return respond(200, site);
  });
  if (privateGrant) {
    context.mocks.http.get(
      `${grant.origin}${grant.pathname}`,
      ({ request }) => {
        const member = selected.find((item) => {
          return item.path === new URL(request.url).searchParams.get("path");
        });
        return member
          ? HttpResponse.text(member.text)
          : new HttpResponse(null, { status: 404 });
      },
    );
  } else {
    for (const member of selected) {
      context.mocks.http.get(new URL(member.path, deployment).href, () => {
        return HttpResponse.text(member.text);
      });
    }
  }
  return site;
}

test.each([false, true])(
  "Site banner downloads authorize and archive every member (revocable grants: %s)",
  async (privateGrant) => {
    mockPublication(privateGrant);
    const browser = context.mocks.browser.blobDownload({ deferRead: true });
    await setupPage({
      context,
      host: "app.okou.ai",
      path: "/artifacts?downloadSite=weekly-report",
    });
    await waitFor(() => {
      return expect(browser.downloads).toHaveLength(1);
    });
    expect(browser.downloads[0]?.filename).toBe("weekly-report.zip");
    const bytes = await browser.downloads[0]!.blob!.arrayBuffer();
    const zip = unzipSync(new Uint8Array(bytes));
    expect(Object.keys(zip).sort()).toStrictEqual(["index.html", "site.css"]);
    for (const member of members) {
      expect(zip[member.path.slice(1)]).toStrictEqual(strToU8(member.text));
    }
  },
);

test("a single-file private Site uses its authorized attachment URL", async () => {
  const site = mockPublication(true, true);
  const browser = context.mocks.browser.blobDownload();
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/artifacts?downloadSite=weekly-report",
  });
  expect(browser.downloads).toHaveLength(1);
  expect(browser.downloads[0]).toMatchObject({
    filename: "index.html",
    url: site.files[0]!.downloadUrl,
    blob: null,
  });
});
