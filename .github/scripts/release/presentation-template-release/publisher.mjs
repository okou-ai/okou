import { verifyBundle } from "./bundle.mjs";
import {
  createDatabaseClient,
  loadStorageState,
  registerPublication,
  verifyDatabasePublication,
} from "./database.mjs";
import { requiredEnv } from "./options.mjs";
import { createR2Client, uploadPackage, verifyR2Objects } from "./r2.mjs";
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
      throw new Error(`${pkg.slug}: production storage state is missing`);
    }
    context.state.set(
      pkg.slug,
      await uploadPackage({ ...context, pkg, release, current }),
    );
  }
}

function logPublishedReleases(releases, state) {
  for (const release of releases) {
    const current = state.get(release.slug);
    writeLine(
      `PUBLISHED ${release.slug} storage=${release.storageId} version=${release.newVersionId} sha256=${release.newSha256} previousVersion=${current.previousVersionId}`,
    );
  }
}

export async function publishBundle(outputDir) {
  const { config, publication } = await verifyBundle(outputDir);
  const releases = releasesForPublication(config, publication);
  const { bucket, client } = createR2Client();
  const sql = createDatabaseClient(requiredEnv("DATABASE_URL"));

  try {
    const state = await loadStorageState(sql, releases);
    await uploadPackages({
      bucket,
      client,
      outputDir,
      publication,
      releases,
      state,
    });
    await registerPublication(sql, releases, state, publication.source.commit);
    await verifyDatabasePublication(sql, releases, state);
    await verifyR2Objects(client, bucket, releases, state);
    logPublishedReleases(releases, state);
  } finally {
    await sql.end({ timeout: 5 });
    client.destroy();
  }
}
