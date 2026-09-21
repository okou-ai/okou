import { randomUUID } from "node:crypto";

import { registryResourceDownloadContract } from "@okouai/api-contracts/contracts/registry-resources";
import { findWebsiteTemplateResource } from "@okouai/core/resource-registry";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { seedPrivateRegistryResourceVersionFixture } from "../../../test-fixtures/private-registry-resource";
import {
  resolvePrivateRegistryResourceArchive,
  registryResourceDownloadRoutes,
} from "../registry-resources-download";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const routeMocks = createRouteMocks(context);

function authHeaders() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  routeMocks.clerk.session(userId, orgId, "org:admin");
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context, routes: registryResourceDownloadRoutes })(
    registryResourceDownloadContract,
  );
}

describe("registry resource download", () => {
  const CURRENT_PRESENTATION_SHA256 =
    "387b2fb59ecac95dbe3b4e6f27d7e6ebda3ce4be317227f6506f87d02e264fc0";

  it("downloads the current presentation template HEAD by resource id", async () => {
    const id = "template:html-ppt-schoolhouse-runbook";
    const anchorVersionId =
      "5968097de13a9a0dda66c464cdd744a53f2018442610775eef4630d21b74c403";
    const headVersionId = "a".repeat(64);
    const s3Key = "registry-fixture/schoolhouse-runbook/latest";
    const fixture = await seedPrivateRegistryResourceVersionFixture({
      storageName: `registry-resource@${id}`,
      versionId: anchorVersionId,
      s3Key: "registry-fixture/schoolhouse-runbook/anchor",
      size: 4321,
      archiveSize: 1234,
      fileCount: 12,
      headVersion: {
        versionId: headVersionId,
        s3Key,
        size: 5432,
        archiveSize: 2345,
        fileCount: 13,
      },
    });
    onTestFinished(fixture.cleanup);

    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "registry-resource-test");
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/registry/schoolhouse-runbook-latest.tar.gz",
    );

    const response = await accept(
      client().downloadPresentationTemplate({
        headers: authHeaders(),
        query: { id },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://r2.example.com/registry/schoolhouse-runbook-latest.tar.gz",
    });
    const signedCommand = context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
    expect(signedCommand).toMatchObject({
      input: {
        Bucket: "registry-resource-test",
        Key: `${s3Key}/archive.tar.gz`,
      },
    });
  });

  it("keeps non-presentation resources off the current-template route", async () => {
    const response = await accept(
      client().downloadPresentationTemplate({
        headers: authHeaders(),
        query: { id: "image-style:vm0-illustration" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("downloads the presentation archive for the current registry digest", async () => {
    const id = "template:html-ppt-schoolhouse-runbook";
    const versionId =
      "5968097de13a9a0dda66c464cdd744a53f2018442610775eef4630d21b74c403";
    const s3Key = "registry-fixture/schoolhouse-runbook/version";
    const fixture = await seedPrivateRegistryResourceVersionFixture({
      storageName: `registry-resource@${id}`,
      versionId,
      s3Key,
      size: 4321,
      archiveSize: 1234,
      fileCount: 12,
    });
    onTestFinished(fixture.cleanup);

    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "registry-resource-test");
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/registry/schoolhouse-runbook.tar.gz",
    );

    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id, expectedSha256: CURRENT_PRESENTATION_SHA256 },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://r2.example.com/registry/schoolhouse-runbook.tar.gz",
      id,
      type: "tar.gz",
      sha256: CURRENT_PRESENTATION_SHA256,
      expiresInSeconds: 172_800,
      versionId,
      fileCount: 12,
      size: 4321,
    });
    const signedCommand = context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
    expect(signedCommand).toMatchObject({
      input: {
        Bucket: "registry-resource-test",
        Key: `${s3Key}/archive.tar.gz`,
      },
    });
  });

  it("rejects an unpublished presentation registry digest through the route", async () => {
    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: {
          id: "template:html-ppt-schoolhouse-runbook",
          expectedSha256:
            "9bd19af256dfb6f17073ec9af52ed0163a5f432a3d143eb82f1fa67aaf8b015e",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it.each([
    {
      slug: "vm0-illustration",
      sha256:
        "03e77d6968190b9f1888a900963135e92f75b40a6c37e1c1bae999ea49669a37",
      versionId:
        "820d2e2ce81805d935e4098d5b6f2899967c2ad5c0af4586f794010c6db66966",
    },
    {
      slug: "emboss-deboss",
      sha256:
        "f1c1be0b1cf711a8c61945f928206d700b54d71969711f0551403d20c360d3f8",
      versionId:
        "e84748dd61e087cc15f12d9f9ecf19d68de790d747e0075b3f9bb6be38975e95",
    },
  ])(
    "downloads the pinned $slug image style archive through the route",
    async ({ slug, sha256, versionId }) => {
      const id = `image-style:${slug}`;
      const s3Key = `registry-fixture/${slug}/version`;
      const fixture = await seedPrivateRegistryResourceVersionFixture({
        storageName: `registry-resource@${id}`,
        versionId,
        s3Key,
        size: 6054,
        archiveSize: 2621,
        fileCount: 1,
      });
      onTestFinished(fixture.cleanup);

      mockEnv("R2_USER_STORAGES_BUCKET_NAME", "registry-resource-test");
      context.mocks.s3.getSignedUrl.mockResolvedValue(
        `https://r2.example.com/registry/${slug}.tar.gz`,
      );

      const response = await accept(
        client().download({
          headers: authHeaders(),
          query: { id, expectedSha256: sha256 },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        url: `https://r2.example.com/registry/${slug}.tar.gz`,
        id,
        type: "tar.gz",
        sha256,
        expiresInSeconds: 172_800,
        versionId,
        fileCount: 1,
        size: 6054,
      });
      const signedCommand =
        context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
      expect(signedCommand).toMatchObject({
        input: {
          Bucket: "registry-resource-test",
          Key: `${s3Key}/archive.tar.gz`,
        },
      });
    },
  );

  it("downloads the presentation reverse-template guide through the route", async () => {
    const id = "skill:presentation-reverse-template";
    const sha256 =
      "4b2bb4ee2a041d57a2fe9ba07b796a690c6dbe130c6e232fa98364b6ed6aeb11";
    const versionId =
      "ec707d2338ddec36a4b413ba7fe58c35987b2b85b2a8ecd441add68dcc1472e7";
    const s3Key = "registry-fixture/presentation-reverse-template/version";
    const fixture = await seedPrivateRegistryResourceVersionFixture({
      storageName: `registry-resource@${id}`,
      versionId,
      s3Key,
      size: 30_489,
      archiveSize: 10_004,
      fileCount: 3,
    });
    onTestFinished(fixture.cleanup);

    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "registry-resource-test");
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/registry/presentation-reverse-template.tar.gz",
    );

    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id, expectedSha256: sha256 },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id,
      sha256,
      versionId,
      fileCount: 3,
      size: 30_489,
    });
    const signedCommand = context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
    expect(signedCommand).toMatchObject({
      input: {
        Bucket: "registry-resource-test",
        Key: `${s3Key}/archive.tar.gz`,
      },
    });
  });

  it("rejects a reverse-template digest that was never published", () => {
    expect(
      resolvePrivateRegistryResourceArchive(
        "skill:presentation-reverse-template",
        "0".repeat(64),
        "4b2bb4ee2a041d57a2fe9ba07b796a690c6dbe130c6e232fa98364b6ed6aeb11",
      ),
    ).toBeUndefined();
  });

  it("downloads current website template archives", async () => {
    const currentStableArchives = [
      {
        id: "template:black-slabs",
        versionId:
          "037045074360d1e6b499fc37a4c5cad208dfd79e59a53bdea78910c5fbe9f2f9",
        sha256:
          "a2ba4a18fe6be58a05a99fcf755f696629c7cbfe295ec9e4f7685bef1eebff79",
      },
      {
        id: "template:blueprint-grid",
        versionId:
          "bbe1a91664e813adf179071713b159fbcd25c42fe9d06860f2ecaea907b06d2b",
        sha256:
          "b0312334dd8ad42f2e8b219cc0522bd11b0de1d246d133b34d9b832352286468",
      },
      {
        id: "template:coastal-hotel",
        versionId:
          "dfcc93538a28f4dd902e82908991c3ed1ee4657f81b12e425ca3469b0bf67af0",
        sha256:
          "4df5f2099cee35c286af6af9e3413f496a6b45b9423d7308336ad8372468efa3",
      },
      {
        id: "template:dot-matrix",
        versionId:
          "fe4915d7c67bfc7e259192072647f62cb064066b0854a84e7fa7cc85bff43112",
        sha256:
          "5d9f69b7f9625681b5b6183623cbece78c4f40dc6fe585ca799212d05e589623",
      },
      {
        id: "template:frame-stack",
        versionId:
          "e9675a20ab0cc0c3970a21ef88716fd5f6f774bf7107739181d1545d6c39d466",
        sha256:
          "b00cbbe2a39486545d695986b6d2be2def28916d4d21fc80591c64d326ddaa5a",
      },
      {
        id: "template:frosted-scatter",
        versionId:
          "2954955f13a31eeb5a9b5cf69c6c170a92c328ed807eed8573bbac52685e2b16",
        sha256:
          "3aa13240db1b905b8222c3eb7eccacfeec44f93aba30e3f495e0e2f1dc395e58",
      },
      {
        id: "template:gallery-wall",
        versionId:
          "8a2ca4ee5c50294cf54053fc29122196b4265fe5955eeec86bd0967778b86033",
        sha256:
          "41941dd3c92814efc30a36ec8c4929aecda48335619c8684c2e0d3c3d0cbd1fa",
      },
      {
        id: "template:glass-bloom",
        versionId:
          "ad5b00f8a2ceb176aa7de7906345d18ab798d0b6835d86ab1e58bfa033822dee",
        sha256:
          "455acd8f36c55a30b3a58654f3f2d5d20b58fcef379b99a28c52aac54246eaf6",
      },
      {
        id: "template:serif-stack",
        versionId:
          "0dcd6eccf59e23d06c2f4653f001db9bb58b443a0ca0d4bfbd3e411a69ea781d",
        sha256:
          "f6eb7b64155f25e9361fbe4f6ea3eb5e7ed626445472e38d15af52b99204036a",
      },
      {
        id: "template:sticker-pop",
        versionId:
          "1435824e871307371108ca9176b8e67dfe1ba4538d52abbf6e6b7b196f5393ad",
        sha256:
          "3f7fb7f11dcf6524eec1aa2f94fb3df145ae78fc21b7797c23fdfd2ec5ec481a",
      },
      {
        id: "template:warm-cards",
        versionId:
          "1ca8a11a520ed6225a32634fe3f2b0f443d10c28f64098f0f1bd0a795a62f16c",
        sha256:
          "52f5f9670b3d0fba697635d35784bc021a2150f1c84cc73af87c6fd049ed8234",
      },
    ] as const;

    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "registry-resource-test");
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/registry/website-template.tar.gz",
    );

    async function expectArchiveDownload(archive: {
      readonly id: string;
      readonly versionId: string;
      readonly sha256: string;
    }) {
      const fixture = await seedPrivateRegistryResourceVersionFixture({
        storageName: `registry-resource@${archive.id}`,
        versionId: archive.versionId,
        s3Key: `registry-fixture/${archive.versionId}`,
        size: 1,
        archiveSize: 1,
        fileCount: 1,
      });
      onTestFinished(fixture.cleanup);

      const response = await accept(
        client().download({
          headers: authHeaders(),
          query: { id: archive.id, expectedSha256: archive.sha256 },
        }),
        [200],
      );

      expect(response.body).toMatchObject({
        id: archive.id,
        versionId: archive.versionId,
        sha256: archive.sha256,
      });
    }

    for (const archive of currentStableArchives) {
      await expectArchiveDownload(archive);
    }

    const v2Archives = [
      {
        id: "template:black-slabs-v2",
        versionId:
          "3a7ccdd16e0c710cf20a0deddbd02d3a58a8125d2b3542648bc261bbaf9c5c91",
        sha256:
          "de6f78c5a524cf3959ca56af7a93ec5bca113555bbd1a5983eebf1bc353971d4",
      },
      {
        id: "template:blueprint-grid-v2",
        versionId:
          "c86f579ecca5f29d45eab19ae19157bdc9a9bc14c99cdbf8611b86aaae3aea70",
        sha256:
          "dec02c4fe156566272a92b7386cb032cec7e3a1250dd42429ca3e7f42374dc28",
      },
      {
        id: "template:coastal-hotel-v2",
        versionId:
          "7c13e39abcabf4cb31bdecdac80e096d6e039367e23c55ca0c3e6647d8fb3583",
        sha256:
          "09d239d7a0e1c27334f2c3c8da9e408174cece6bcc8a34342438598db739aa4e",
      },
      {
        id: "template:dot-matrix-v2",
        versionId:
          "9a8977088b02b43d15654674571a88c0128b29076bb8e837d47ddd3a6ea4fd6a",
        sha256:
          "0beb9b1bcb12ace6d3541df269a629af8e3b41c8f9d7e3c3fcfe069655cd9074",
      },
      {
        id: "template:frame-stack-v2",
        versionId:
          "cb8cf528ebfce90e6f78081fbaee0029f2790ff5398ffa0642a6c30c8c1e0c1b",
        sha256:
          "7c4c13eaa22b4185607c6ac6a726dd931fe896b279b38a6267c0105f81214f8b",
      },
      {
        id: "template:frosted-scatter-v2",
        versionId:
          "7cab5008dbe877dd5ac43e3511d06109d101dda389bbdcc4589396ff495d9d41",
        sha256:
          "c67a7baf924ae4b57241e61527dd875d084e38040653a9bbcc659c13d2382cf9",
      },
      {
        id: "template:gallery-wall-v2",
        versionId:
          "c208b3119387422c4487d1a9a6f3c8f1618d0ee77dcfd51cbe26e6b4092cb002",
        sha256:
          "f6e41fb711b8c9317a425b463a9812e99f2aecb630d1acbfb77ef0965c2ba55f",
      },
      {
        id: "template:glass-bloom-v2",
        versionId:
          "fe6ac8450b6f822707c3e38c2705b2b88828c9226befa090086dc53635d9f9b6",
        sha256:
          "713fbac57cf37a0ddd6d7e7d79a0b9f29f8fff7a0aa55bc741bc5dcd0e498d25",
      },
      {
        id: "template:serif-stack-v2",
        versionId:
          "e61f178818ccf31a0676ca0183fccbaef3019972adab592d8a5ba17287f54f65",
        sha256:
          "6d5d65fb21d6c5ec5627fe32fbfc55e80841a2343f2d91bf3ee3a0f62547766a",
      },
      {
        id: "template:sticker-pop-v2",
        versionId:
          "d358cbcd29fc725fc282f4675ebba533fd60af564038d8efa0d4a057a29aee5b",
        sha256:
          "61954f4652e2cc86cd1016a537078ea050fe95735a7477e6bd56c91a0c0aec3b",
      },
      {
        id: "template:warm-cards-v2",
        versionId:
          "f587c890c6db593a4cd102cb863f2484868277200d5630b40712ee8b2ded3153",
        sha256:
          "213197ef200b16738b51b5d6c4a90b6e6c12c86c63207ef6afc31456cdd0d2e1",
      },
    ] as const;

    for (const archive of v2Archives) {
      // The pinned digest must be the one the registry ships, otherwise the
      // version ids below would be resolved for an archive nobody pulls.
      expect(
        findWebsiteTemplateResource(archive.id)?.source.archive,
      ).toStrictEqual({
        type: "tar.gz",
        sha256: archive.sha256,
      });

      expect(
        resolvePrivateRegistryResourceArchive(
          archive.id,
          archive.sha256,
          archive.sha256,
        ),
      ).toMatchObject({
        versionId: archive.versionId,
        sha256: archive.sha256,
      });
    }
  }, 15_000);

  it("rejects registry resources that are not in the private archive allowlist", async () => {
    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id: "template:dashboard", expectedSha256: "0".repeat(64) },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
