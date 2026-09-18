import { randomUUID } from "node:crypto";
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
  "binds hosted upload credentials to the declared bytes (private: %s)",
  async (privateArtifacts) => {
    const { actor, capture } = await fixture(privateArtifacts);
    const files = [
      hostedTextFile("/index.html", "<main>Immutable report</main>"),
      hostedTextFile(
        "/assets/manifest.json",
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
      // The storage boundary must receive the checksum, so its signature
      // cannot authorize replacing published content with different bytes.
      expect(context.mocks.s3.getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            Key: expect.stringContaining(file.path),
            ChecksumSHA256: Buffer.from(file.sha256, "hex").toString("base64"),
          }),
        }),
        expect.objectContaining({ expiresIn: 172_800 }),
      );
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
    ).toContain("/assets/manifest.json");
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
