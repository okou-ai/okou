import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

const PREFIX = "pi-api-first-turn/";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function runCleanup(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { execute: { type: "boolean", default: false } },
    strict: true,
    allowPositionals: false,
  });
  const bucket = requiredEnv("R2_USER_STORAGES_BUCKET_NAME");
  const client = new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint:
      process.env.S3_ENDPOINT ??
      `https://${requiredEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    maxAttempts: 1,
  });
  let objects = 0;
  let deleted = 0;
  let continuationToken: string | undefined;
  try {
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: PREFIX,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (page.Contents ?? []).map((object) => {
        if (!object.Key?.startsWith(PREFIX)) {
          throw new Error(
            "Storage returned an object outside the retired prefix",
          );
        }
        return { Key: object.Key };
      });
      if (page.IsTruncated && !page.NextContinuationToken) {
        throw new Error("Storage returned a truncated page without a cursor");
      }
      objects += keys.length;
      if (values.execute && keys.length > 0) {
        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys, Quiet: true },
          }),
        );
        if (result.Errors?.length) {
          throw new Error(
            `Storage rejected ${String(result.Errors.length)} object deletions; cleanup is incomplete`,
          );
        }
        deleted += keys.length;
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);

    if (values.execute) {
      const remaining = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: PREFIX,
          MaxKeys: 1,
        }),
      );
      if (remaining.Contents?.length || remaining.IsTruncated) {
        throw new Error(
          "Retired handoff objects remain; cleanup is incomplete",
        );
      }
    }
    console.log(
      JSON.stringify({
        mode: values.execute ? "execute" : "dry-run",
        bucket,
        prefix: PREFIX,
        objects,
        deleted,
        verifiedEmpty: values.execute,
      }),
    );
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runCleanup(process.argv.slice(2));
