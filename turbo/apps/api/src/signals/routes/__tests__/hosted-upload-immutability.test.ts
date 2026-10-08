import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const api = createHostMapsBddApi(context);

async function fixture(privateArtifacts: boolean) {
  const actor = bdd.user();
  await createRunsApi(context).grantProEntitlement(actor);
  await createBillingMediaApi(context).updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PrivateArtifacts]: privateArtifacts,
  });
  const capture = api.captureHostedSitesS3();
  return { actor, capture };
}

test.each([true, false])(
  "issues normal 48-hour hosted PUT credentials without checksum binding (private: %s)",
  async (privateArtifacts) => {
    const { actor, capture } = await fixture(privateArtifacts);
    const files = [
      hostedTextFile("/index.html", "<main>Immutable report</main>"),
      hostedTextFile(
        "/assets/manifest-3f8c2d91.json",
        '{"name":"Report"}',
        "application/json",
      ),
    ];
    const draft = await api.prepareHostedSite(actor, {
      site: `immutable-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      files,
    });

    for (const file of files) {
      const signing = context.mocks.s3.getSignedUrl.mock.calls.find((call) => {
        return (
          call[1] instanceof PutObjectCommand &&
          call[1].input.Key?.endsWith(file.path)
        );
      });
      if (!signing || !(signing[1] instanceof PutObjectCommand)) {
        throw new Error("Expected a signed hosted PUT");
      }
      expect(signing[1].input.Key).toContain(file.path);
      expect(signing[1].input.ChecksumSHA256).toBeUndefined();
      expect(signing[2]).toMatchObject({ expiresIn: 172_800 });
    }

    await api.completeHostedSite(actor, draft.deploymentId);
    const manifests = capture.puts.filter(({ key }) => {
      return key.endsWith("/manifest.json");
    });
    expect(manifests).toHaveLength(1);
    expect(JSON.parse(manifests[0]!.body)).toMatchObject({
      deploymentId: draft.deploymentId,
      immutableContent: true,
    });
    const downloaded = await api.readHostedSiteFiles(
      actor,
      `dpl-${draft.deploymentId}`,
    );
    expect(
      downloaded.files.map((file) => {
        return file.path;
      }),
    ).toContain("/assets/manifest-3f8c2d91.json");
  },
);

test("rejects uploads that would overwrite the server delivery manifest", async () => {
  const { actor } = await fixture(true);
  const response = await api.requestPrepareHostedSite(
    actor,
    {
      site: `reserved-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [
        hostedTextFile("/index.html", "<main>Report</main>"),
        hostedTextFile("/manifest.json", "{}", "application/json"),
      ],
    },
    [400],
  );
  expect(response.body).toMatchObject({
    error: { message: "Hosted-site path is reserved: /manifest.json" },
  });
});

test("rejects an asset whose name does not carry its content hash", async () => {
  const { actor } = await fixture(false);
  const response = await api.requestPrepareHostedSite(
    actor,
    {
      site: `unhashed-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [
        hostedTextFile("/index.html", "<main>Report</main>"),
        hostedTextFile("/assets/app.css", "h1{color:green}", "text/css"),
      ],
    },
    [400],
  );
  expect(response.body).toMatchObject({
    error: {
      message: expect.stringContaining(
        "Hosted-site asset must carry a content hash in its file name: /assets/app.css",
      ) as unknown as string,
    },
  });
});

test("rejects republishing a published asset path with different bytes", async () => {
  const { actor } = await fixture(false);
  const site = `republished-${randomUUID().slice(0, 8)}`;
  const asset = "/assets/app-4f3a9c12.css";
  const first = await api.prepareHostedSite(actor, {
    site,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [
      hostedTextFile("/index.html", "<main>Report</main>"),
      hostedTextFile(asset, "h1{color:green}", "text/css"),
    ],
  });
  await api.completeHostedSite(actor, first.deploymentId);

  // The same name must keep its bytes; only documents may change.
  const response = await api.requestPrepareHostedSite(
    actor,
    {
      site,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [
        hostedTextFile("/index.html", "<main>Updated</main>"),
        hostedTextFile(asset, "h1{color:red}", "text/css"),
      ],
    },
    [409],
  );
  expect(response.body).toMatchObject({
    error: {
      message: expect.stringContaining(
        `Hosted-site asset changed without a new file name: ${asset}`,
      ) as unknown as string,
    },
  });

  // Unchanged bytes under the same name still redeploy.
  const redeployed = await api.prepareHostedSite(actor, {
    site,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [
      hostedTextFile("/index.html", "<main>Updated</main>"),
      hostedTextFile(asset, "h1{color:green}", "text/css"),
    ],
  });
  expect(redeployed).toMatchObject({
    siteId: first.siteId,
    publicSlug: first.publicSlug,
    deploymentVersion: 2,
  });
});
