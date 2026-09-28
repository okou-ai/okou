import { PutObjectCommand } from "@aws-sdk/client-s3";
import { vi } from "vitest";

/** Re-sign the command/options observed at the API boundary with the actual AWS SDK. */
export async function realSignedPutUrl(
  call: readonly unknown[] | undefined,
): Promise<URL> {
  const command = call?.[1];
  const options = call?.[2];
  if (
    !(command instanceof PutObjectCommand) ||
    typeof options !== "object" ||
    options === null
  ) {
    throw new Error("Expected a recorded PUT signing call");
  }
  const s3 =
    await vi.importActual<typeof import("@aws-sdk/client-s3")>(
      "@aws-sdk/client-s3",
    );
  const presigner = await vi.importActual<
    typeof import("@aws-sdk/s3-request-presigner")
  >("@aws-sdk/s3-request-presigner");
  const client = new s3.S3Client({
    region: "auto",
    endpoint: "https://synthetic.r2.cloudflarestorage.com",
    forcePathStyle: true,
    credentials: {
      accessKeyId: "SYNTHETIC_TEST_ACCESS_KEY",
      secretAccessKey: "SYNTHETIC_TEST_SECRET_KEY",
    },
  });
  const signed = await presigner
    .getSignedUrl(
      client,
      new s3.PutObjectCommand(command.input),
      options as Parameters<typeof presigner.getSignedUrl>[2],
    )
    .finally(() => {
      client.destroy();
    });
  return new URL(signed);
}
