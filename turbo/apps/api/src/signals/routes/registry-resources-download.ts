import { computed } from "ccstate";
import { registryResourceDownloadContract } from "@okouai/api-contracts/contracts/registry-resources";
import {
  findColorSystem,
  findDesignSystem,
  findImageStyle,
  findPresentationReverseTemplateResource,
  findPresentationRunbookResource,
  findSkill,
  findTemplate,
  findTool,
  findVideoTemplate,
  findWebsiteTemplateResource,
  type RegistryEntry,
  type VideoTemplateRegistryEntry,
} from "@okouai/core/resource-registry";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { notFound } from "../../lib/error";
import { resolveWebsiteTemplateArchiveVersionId } from "../../lib/website-template-archive-versions";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import type { RouteEntry } from "../route-entry";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";

type PullableRegistryEntry = RegistryEntry | VideoTemplateRegistryEntry;

interface PrivateRegistryResourceArchive {
  readonly storageName: string;
  readonly versionId: string;
  readonly sha256: string;
}

const DOWNLOAD_URL_TTL_SECONDS = PRESIGNED_URL_TTL_SECONDS;

function storageServiceNotConfigured() {
  return {
    status: 500 as const,
    body: {
      error: {
        message: "Storage service is not properly configured",
        code: "INTERNAL_ERROR" as const,
      },
    },
  };
}

const PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS = {
  // Presentation reverse-template guide from maxandzoe/Template-artifact@7daba24.
  "skill:presentation-reverse-template":
    "ec707d2338ddec36a4b413ba7fe58c35987b2b85b2a8ecd441add68dcc1472e7",
  "color-system:bauhaus-primary":
    "26c34a2a33a5c7b751b6741da5e4013020d5dbe138e60f5b3a444f4a5d3a351b",
  "color-system:berry-pop":
    "a9e00d18e3042262affb0d1396bd010aa8fa548f6b89e8ae1d634aec37a955b7",
  "color-system:carnival":
    "112848d050081ddca2d8ffc57a685906998a7073ddd7585cc4d94f9060b439b8",
  "color-system:citrus-fresh":
    "556f9d77f9aa835475b423639e8d642f6e63d5c66f7a4b5b954a37c058292b30",
  "color-system:coral-studio":
    "15103787a715de87210ed905a7e35e76694a7a33f3c1a2d734ea54239fba1280",
  "color-system:forest-editorial":
    "24cc3c0b4062114e877221d0f50bde4de00c90838d7a54f6013c9038bdd2e19d",
  "color-system:gold-luxe":
    "b4c5af7c9bddc8ef1e47d681fadd678852f3b4dc7a9eafd749eca54ba60acbe7",
  "color-system:mauve-dusk":
    "181f5d2ee8dfd765563b891693dc145f77a313013f788c799bfefadc231bbcf8",
  "color-system:midnight-mono":
    "a9cfc3533f23d04b48e7270a45f4577c5e055509bad35118a23a14ad8c52345b",
  "color-system:mint-tech":
    "19bf57aae59ef94b0cb18dcfed6d5ab6d55b3d38f7196c704e9301351820db8d",
  "color-system:mono-ink":
    "cc135f036e03e30773d2e01739ed93e0b578f501f44019114e4674bd6a05d932",
  "color-system:nordic-frost":
    "a1b0f1018d46dabfb004c933f6a557b43498e8c957e8d5fe1375ab8d1699a9aa",
  "color-system:ocean-deep":
    "c848d3aac65c0c9a8f749c61a5aad5f634cf5d7d75d78f1080a45530d3bfdc78",
  "color-system:pop-art":
    "82d9330442d86f9969748acf12fd964e9999cad0089b441f57df708cf43ccf79",
  "color-system:prism":
    "45c23078172e802ed40e81922b072407bb6a19bf839d5e5be2431d30cc9190c9",
  "color-system:slate-corporate":
    "c082c9a8e96aa2c29720e8b06eb827d56f10b0fa5db05112f65cd3a251b65b49",
  "color-system:sunset-maroon":
    "d2bde0b6b2dc8d23342040458315eab71fedebdfc4e278ca1de7255eeac6b7e0",
  "color-system:terracotta-clay":
    "f23a7edd4705fcf7b8086da55553a601194bcd857be15de7072128ff916a03ad",
  "color-system:warm-sand":
    "e9ea329a25491e347cb3c1156735201a4ff7f8a299dd8990b024d31854b49050",
  // Emboss & Deboss from vm0-ai/vm0-skills@e696652.
  "image-style:emboss-deboss":
    "e84748dd61e087cc15f12d9f9ecf19d68de790d747e0075b3f9bb6be38975e95",
  // Image style packages manually published from vm0-ai/vm0-skills@45e237a.
  "image-style:cozy-parlor":
    "b6ce5ecd7207360f6929616daea4c054aa9583ee24ca64eeb7d5aca5c9767db5",
  "image-style:crowd-ink":
    "3389f30fbdc8248c5885ab94edb667a3d7fb4a17018162233bf0ca6c4d5e72cc",
  "image-style:editorial-flatfolk":
    "d03620d739815baca2764e9fa3ea520a639d0487988c47f58bdb17fca61fd80a",
  "image-style:endpaper":
    "72f75194d1e27bf5b9222473a74c63fe27ca700e435c4e47cb7642d44d8f1297",
  "image-style:flat-poster":
    "73292de49674ba797b2f86b3babb14b899ba5e7047c9f13dc63fce52c81d04aa",
  "image-style:folk-muse":
    "3446e78cf337b24dd1a5a6530fe2926b7ca6b153b7393be338b782b633543cdc",
  "image-style:folk-storybook":
    "96a309a4bc6ddf6fdc30488a0a74e576a0a7f1ebbae2da14b08a0dd9cc02b9d7",
  "image-style:grain-poster":
    "771417220bcea158f9729e15b085de61aeb0d771d5dd39ca6e63711a8b47c4e5",
  "image-style:grainy-duotone":
    "21b5f3f0f6ec7d32ba3e1c8ff49048c481327f484807c093465824c0fbbf26c6",
  "image-style:iberian-vignette":
    "7e875c6fd6f154d87aa27d0aceb69dbb36fe084299642d2d3ec0c24fdb2dd730",
  "image-style:ink-mascot":
    "408ab314cc262395fbd6d257cb981976327a5b6a2742d62b3646b9dc49c7df07",
  "image-style:ink-storefront":
    "ec8d871a9739e6d276b058336904b6a95bdc0ec56de5de91b40bdd8cc910277b",
  "image-style:inkdab":
    "40e1663067c705935086ed61d8e7610da32b4dab707b92e3dc1a3a60fdc44dbe",
  "image-style:inkstomp":
    "035a7fe17aef573086f24552de23363adc39f51b28d2b5415a59da4fac83a98a",
  "image-style:iso-scene":
    "32b295fff8931cbc1db4754b481ee432e70119da22f32881ebab180479c7a6f8",
  "image-style:jade-blockprint":
    "5a1103c33434979c4ce997da0e2f66cb8f90ba598d20b319b09e47d8ec2af289",
  "image-style:light-pop-portrait":
    "77eafa06066c0f8ebfa11af0fe83eace551db5e008378f710d3264dba45e4b82",
  "image-style:loose-contour":
    "228ad875fdad30feb0101f48db70d58a7cdcf200c07510d256a539bea292ee1f",
  "image-style:mellow-pop":
    "32ce89482cc85dc27b20ccbf57756b814f9fae88bc7cf5f5979a7b26b5f0dc26",
  "image-style:mosaic-still-life":
    "db22e147647987a182e69fba0ce1864b2f5dff5c0b5e1a6db7487b0ce22c13a1",
  "image-style:notion-illustration":
    "82d5ab3a95484702df121449dda63c086cd7ef06e9240c6620846afd5bfea079",
  "image-style:op-ed-cover":
    "c5223ade7d86bef1691d71e95286558a5ff533ca604d51d360bea20c4f250f48",
  "image-style:painterly-botanical":
    "3c6f0874686d0e021680bf28dfd81e7eb81d0eaa6b355e4732c524c5bfac3d4a",
  "image-style:papernook":
    "aada3a4b40f0989d779ee1d3b1471addca557cafd8135d0cd061932d0e7e2314",
  "image-style:postcard-illustration":
    "1fd4876ba668a0b6ff5bff0c95610c6ba8f8a87dbcebe31d91c73955358a2aa4",
  "image-style:riso-relic":
    "b3c5bd37419a0f627ee7a4c8941a4a21c351e5d4f45cec82eefa7ddaf58adfd6",
  "image-style:shadow-pop":
    "5c1179938f3bb07ca84a11b2ea4e01c3bcdd72f0383d5549434fe4ffe37b8969",
  "image-style:soft-vector":
    "ede91c010b3ac2b5bd80df9dca436ce9006acd9ac5af7f33c5590309ca7c6f53",
  "image-style:sticker-sheet":
    "a5d1fbaeeb87247996c5b6d801fb135b4b6e5f5db9a4c22f4cb58269578c33f7",
  "image-style:sunlit-gouache":
    "9156b502d879ce3f8715ec3aa309d62e46ee691d5f86d5a8355f14aec90b4d3a",
  "image-style:tiny-wanderer":
    "f728fa4248d2da8ba9be92c14266059c613952e5d8d6e5b2e3a73fe8bacced55",
  "image-style:vm0-illustration":
    "820d2e2ce81805d935e4098d5b6f2899967c2ad5c0af4586f794010c6db66966",
  // Presentation runbook packages (self-contained per-template archives).
  "template:html-ppt-bloom-pitch-runbook":
    "a27d82cae6cdeb84103c70705e2a2f6193948cbdb894aaeee6d3638de949bb11",
  "template:html-ppt-blueprint-academy-runbook":
    "02077258dd6ba2d12271ffedc2d1cf6c0ac3a16f6eb9a92246a92a5419e176ed",
  "template:html-ppt-botane-organic-runbook":
    "07231d8f7259db331a7b21eb190e7d887d9e26fb1b7dcacac46c3ca018ebd9d6",
  "template:html-ppt-business-data-runbook":
    "c8b571a0e2033a8167578685431daa54ebd4e37349771a972c059eb4b18c80d2",
  "template:html-ppt-crayon-runbook":
    "10d96f99628483c0316558e0e953ada3752a1081e8efa5cf5de2d7c80a535062",
  "template:html-ppt-creative-agency-runbook":
    "335fbaeab805a9a43d12aa76109b76967d068e3589abc583309bd91f46c57d06",
  "template:html-ppt-data-report-runbook":
    "7f12591d77e7f10370e719177d9bd6971bb39f70ee523db4d63f1903b5be1c58",
  "template:html-ppt-editorial-magazine-runbook":
    "cb9ab480b90d244bdad2a5558685e029179f0cbca24440f5b839645f56dba1e6",
  "template:html-ppt-landing-consulting-runbook":
    "51e83fa99ace1efecc4a9377fc568b5e0019570b0c41d07bc7e91b8dd23134fd",
  "template:html-ppt-lumina-runbook":
    "eb6caf4fef7a9c9a090619adaa9d519cfa07853ccf0187c606845f2ff45a05c2",
  "template:html-ppt-meridian-runbook":
    "0a2640e872d20da93b749b47fa530d910ae3767372de7a539e1da08fb9a86d0a",
  "template:html-ppt-mosaic-geometric-runbook":
    "c122104f5f40ab093ef7ff18fc9a7becbba21eda1834a7e4ae500e5be3bad012",
  "template:html-ppt-neo-brutalism-runbook":
    "6ef2724a5b511909c72e404b9fa6f67e0269a535eca6bd484bc73316bfd99cfe",
  "template:html-ppt-nocturne-runbook":
    "2a20b5307b01ca1ae43de4b8045dcd1be4d68c43123d34d77e10a770cc9e5092",
  "template:html-ppt-pixel-glitch-runbook":
    "109943a86459c9c1a3197d94124b7f96f85c71023f73fd9850ac3e9cc19ed3ce",
  "template:html-ppt-playful-launch-runbook":
    "e1a4b54088cf63a29f56780ca31dbfdba0ba39ff32c9a9ad14a4a470773862c0",
  "template:html-ppt-playful-pop-runbook":
    "87adf6d8063be6acd9a8aa044d2cd4359932c2dd238a6403aed03c32f11cfda7",
  "template:html-ppt-prospectus-runbook":
    "4b57858e10558e741c3577dafa7bfdef9b96a1ff9be4c7a8c3cfc6c4fc9266a2",
  "template:html-ppt-schoolhouse-runbook":
    "5968097de13a9a0dda66c464cdd744a53f2018442610775eef4630d21b74c403",
  "template:html-ppt-sticker-scrapbook-runbook":
    "16218ebefa4d55554f7db7e6d6e7f18ffe6c53e657b044db7ea69781b11c4906",
  "template:html-ppt-strata-runbook":
    "9f403b39dc7eab2db4d09ad74e1acd89201d6f982c654166af19ce6b69165fa6",
  "template:html-ppt-taped-consulting-runbook":
    "33b13adddfe94f558ed91ae235e69312b3f4fc5150ff77b6718253eaf6c69ff0",
  "template:html-ppt-vantage-runbook":
    "6e845f03b79a1c4683f9b9bfe8f018eb9808642d6cadbef9ab505d6892ab5adb",
} as const satisfies Record<string, string>;

export function resolvePrivateRegistryResourceArchive(
  id: string,
  expectedSha256: string,
  defaultSha256: string,
): PrivateRegistryResourceArchive | undefined {
  const websiteVersionId = resolveWebsiteTemplateArchiveVersionId(
    id,
    expectedSha256,
    defaultSha256,
  );
  if (websiteVersionId) {
    return {
      storageName: `registry-resource@${id}`,
      versionId: websiteVersionId,
      sha256: expectedSha256,
    };
  }

  const defaultVersionId =
    PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS[
      id as keyof typeof PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS
    ];
  if (!defaultVersionId) {
    return undefined;
  }

  if (expectedSha256 !== defaultSha256) {
    return undefined;
  }

  return {
    storageName: `registry-resource@${id}`,
    versionId: defaultVersionId,
    sha256: expectedSha256,
  };
}

function findRegistryResource(id: string): PullableRegistryEntry | undefined {
  return (
    findSkill(id) ??
    findTool(id) ??
    findTemplate(id) ??
    findDesignSystem(id) ??
    findColorSystem(id) ??
    findImageStyle(id) ??
    findVideoTemplate(id) ??
    findPresentationReverseTemplateResource(id) ??
    findPresentationRunbookResource(id) ??
    findWebsiteTemplateResource(id)
  );
}

function archiveFilename(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.tar.gz`;
}

const downloadPresentationTemplateInner$ = computed(async (get) => {
  const query = get(
    queryOf(registryResourceDownloadContract.downloadPresentationTemplate),
  );
  const entry = findPresentationRunbookResource(query.id);
  if (!entry || !entry.source.archive) {
    return notFound(`Presentation template "${query.id}" was not found`);
  }

  const anchor = resolvePrivateRegistryResourceArchive(
    query.id,
    entry.source.archive.sha256,
    entry.source.archive.sha256,
  );
  if (!anchor) {
    return notFound(`Presentation template "${query.id}" was not found`);
  }

  const db = get(db$);
  const [storage] = await db
    .select({
      id: storages.id,
      headVersionId: storages.headVersionId,
    })
    .from(storageVersions)
    .innerJoin(
      storages,
      and(
        eq(storages.id, storageVersions.storageId),
        eq(storages.name, anchor.storageName),
      ),
    )
    .where(eq(storageVersions.id, anchor.versionId))
    .limit(1);

  if (!storage?.headVersionId) {
    return notFound(`Current archive for "${query.id}" was not found`);
  }

  const [version] = await db
    .select({
      s3Key: storageVersions.s3Key,
    })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storage.id),
        eq(storageVersions.id, storage.headVersionId),
      ),
    )
    .limit(1);

  if (!version) {
    return notFound(`Current archive for "${query.id}" was not found`);
  }

  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  if (!bucket) {
    return storageServiceNotConfigured();
  }

  const url = await get(
    generatePresignedGetUrl(
      bucket,
      `${version.s3Key}/archive.tar.gz`,
      archiveFilename(query.id),
      true,
    ),
  );

  return {
    status: 200 as const,
    body: {
      url,
    },
  };
});

const downloadRegistryResourceInner$ = computed(async (get) => {
  const query = get(queryOf(registryResourceDownloadContract.download));
  const entry = findRegistryResource(query.id);
  const archive = entry?.source.archive;
  if (!entry || !archive) {
    return notFound(`Registry resource "${query.id}" has no archive source`);
  }

  const privateArchive = resolvePrivateRegistryResourceArchive(
    query.id,
    query.expectedSha256,
    archive.sha256,
  );
  if (!privateArchive) {
    return notFound(`Registry resource "${query.id}" is not private-pullable`);
  }

  const db = get(db$);
  const [version] = await db
    .select({
      s3Key: storageVersions.s3Key,
      fileCount: storageVersions.fileCount,
      size: storageVersions.size,
    })
    .from(storageVersions)
    .innerJoin(storages, eq(storages.id, storageVersions.storageId))
    .where(
      and(
        eq(storages.name, privateArchive.storageName),
        eq(storageVersions.id, privateArchive.versionId),
      ),
    )
    .limit(1);

  if (!version) {
    return notFound(`Private archive for "${query.id}" was not found`);
  }

  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  if (!bucket) {
    return storageServiceNotConfigured();
  }

  const url = await get(
    generatePresignedGetUrl(
      bucket,
      `${version.s3Key}/archive.tar.gz`,
      archiveFilename(query.id),
      true,
    ),
  );

  return {
    status: 200 as const,
    body: {
      url,
      id: entry.id,
      type: archive.type,
      sha256: privateArchive.sha256,
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      versionId: privateArchive.versionId,
      fileCount: version.fileCount,
      size: Number(version.size),
    },
  };
});

export const registryResourceDownloadRoutes: readonly RouteEntry[] = [
  {
    route: registryResourceDownloadContract.downloadPresentationTemplate,
    handler: authRoute(
      { requiredCapability: "file:read" },
      downloadPresentationTemplateInner$,
    ),
  },
  {
    route: registryResourceDownloadContract.download,
    handler: authRoute(
      { requiredCapability: "file:read" },
      downloadRegistryResourceInner$,
    ),
  },
];
