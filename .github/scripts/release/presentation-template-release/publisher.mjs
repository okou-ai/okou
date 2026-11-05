import { verifyBundle } from "./bundle.mjs";
import {
  createDatabaseClient,
  loadPublicationState,
  registerPublication,
  verifyDatabasePublication,
} from "./database.mjs";
import { requiredEnv } from "./options.mjs";
import { createRegistryR2Client, uploadRegistryPackage } from "./r2.mjs";
import { writeLine } from "./shared.mjs";

function releasesForPublication(config, publication) {
  const packagesBySlug = new Map(
    publication.packages.map((pkg) => [pkg.slug, pkg]),
  );
  return config.templates.map((release) => {
    const pkg = packagesBySlug.get(release.slug);
    if (!pkg) {
      throw new Error(`${release.slug}: publication package is missing`);
    }
    return {
      ...release,
      newVersionId: pkg.versionId,
      newSha256: pkg.archive.sha256,
    };
  });
}

function assertPackageRelease(pkg, release) {
  if (
    pkg.storageId !== release.storageId ||
    pkg.versionId !== release.newVersionId ||
    pkg.archive.sha256 !== release.newSha256
  ) {
    throw new Error(`${pkg.slug}: publication does not match release metadata`);
  }
}

async function uploadPackages(context) {
  const releasesBySlug = new Map(
    context.releases.map((release) => [release.slug, release]),
  );
  for (const pkg of context.publication.packages) {
    const release = releasesBySlug.get(pkg.slug);
    if (!release) {
      throw new Error(`${pkg.slug}: release metadata is missing`);
    }
    assertPackageRelease(pkg, release);

    const current = context.state.get(pkg.slug);
    if (!current) {
      throw new Error(`${pkg.slug}: production registry state is missing`);
    }
    const uploaded = await uploadRegistryPackage({
      client: context.client,
      bucket: context.bucket,
      outputDir: context.outputDir,
      pkg,
      release,
    });
    context.state.set(pkg.slug, { ...current, ...uploaded });
  }
}

function logPublishedReleases(releases, state) {
  for (const release of releases) {
    const current = state.get(release.slug);
    writeLine(
      `PUBLISHED ${release.slug} resource=${release.resourceId} version=${release.newVersionId} sha256=${release.newSha256} previousVersion=${current.previousVersionId}`,
    );
  }
}

export async function publishBundle(outputDir) {
  const { config, publication } = await verifyBundle(outputDir);
  const releases = releasesForPublication(config, publication);
  const { bucket, client } = createRegistryR2Client();
  let sql;

  try {
    sql = createDatabaseClient(requiredEnv("DATABASE_URL"));
    const state = await loadPublicationState(sql, releases);
    await uploadPackages({
      bucket,
      client,
      outputDir,
      publication,
      releases,
      state,
    });
    await registerPublication(sql, releases, state);
    await verifyDatabasePublication(sql, releases, state);
    logPublishedReleases(releases, state);
  } finally {
    try {
      await sql?.end({ timeout: 5 });
    } finally {
      client.destroy();
    }
  }
}
