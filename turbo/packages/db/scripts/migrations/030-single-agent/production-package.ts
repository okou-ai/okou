import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { constants } from "node:fs";
import { gunzipSync } from "node:zlib";
import { c as createTar, Parser } from "tar";
import { writePrivate } from "./execution-model";
import { PlanningError } from "./snapshot";

const magic = Buffer.from("OKOU-SINGLE-AGENT-1\n");
const limit = 256 * 1024 * 1024;
const receipt = /^[a-f0-9-]{36}-(started|published|complete)\.json$/u;
const bundle = /^bundles\/[a-f0-9]{64}\.tar\.gz$/u;
const allowed = (path: string) => {
  return path === "execution.json" || receipt.test(path) || bundle.test(path);
};

export function packageKey(value: string) {
  if (!/^[a-f0-9]{64}$/u.test(value))
    throw new PlanningError("DedicatedProductionPackageKeyRequired");
  return Buffer.from(value, "hex");
}

export function sealBytes(bytes: Uint8Array, key: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([
    magic,
    iv,
    cipher.update(bytes),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

export function openBytes(bytes: Buffer, key: Buffer, aad: string) {
  if (
    bytes.length > limit ||
    bytes.length < magic.length + 28 ||
    !bytes.subarray(0, magic.length).equals(magic)
  )
    throw new PlanningError("InvalidProductionPackage");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    bytes.subarray(magic.length, magic.length + 12),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(-16));
  try {
    return Buffer.concat([
      decipher.update(bytes.subarray(magic.length + 12, -16)),
      decipher.final(),
    ]);
  } catch {
    throw new PlanningError("ProductionPackageAuthenticationFailed");
  }
}

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.mode & 0o077)
    throw new PlanningError("PrivatePackageDirectoryRequired");
}

export async function sealExecutionDirectory(
  directory: string,
  output: string,
  key: Buffer,
  aad: string,
) {
  await privateDirectory(directory);
  await privateDirectory(join(directory, "bundles"));
  const roots = await readdir(directory);
  if (
    roots.some((path) => {
      return (
        path !== "bundles" && path !== "execution.json" && !receipt.test(path)
      );
    })
  )
    throw new PlanningError("UnexpectedProductionPackageFile");
  const files = [
    ...roots.filter((path) => {
      return path !== "bundles";
    }),
    ...(await readdir(join(directory, "bundles"))).map((path) => {
      return `bundles/${path}`;
    }),
  ].sort();
  let total = 0;
  if (!files.includes("execution.json") || files.length > 1024)
    throw new PlanningError("InvalidProductionPackageFiles");
  for (const file of files) {
    const info = await lstat(join(directory, file));
    if (
      !allowed(file) ||
      !info.isFile() ||
      info.mode & 0o077 ||
      info.size > limit
    )
      throw new PlanningError("InvalidProductionPackageFile");
    total += info.size;
  }
  if (total > 2 * limit) throw new PlanningError("ProductionPackageTooLarge");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createTar(
    { cwd: directory, gzip: true, portable: true, noMtime: true, strict: true },
    files,
  )) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit - 1024)
      throw new PlanningError("ProductionPackageTooLarge");
    chunks.push(bytes);
  }
  await writePrivate(output, sealBytes(Buffer.concat(chunks), key, aad));
}

export async function openExecutionDirectory(
  input: string,
  directory: string,
  key: Buffer,
  aad: string,
) {
  // Authenticate before parsing or writing any plaintext archive entry.
  const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let sealed: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw new PlanningError("InvalidProductionPackage");
    sealed = await file.readFile();
  } finally {
    await file.close();
  }
  const compressed = openBytes(sealed, key, aad);
  const archive = gunzipSync(compressed, { maxOutputLength: 2 * limit });
  await mkdir(directory, { mode: 0o700 });
  let complete = false;
  try {
    await mkdir(join(directory, "bundles"), { mode: 0o700 });
    const seen = new Set<string>();
    const contents = new Map<string, Buffer>();
    let invalid = false;
    const parser = new Parser({
      strict: true,
      onReadEntry(entry) {
        if (
          !allowed(entry.path) ||
          seen.has(entry.path) ||
          seen.size >= 1024 ||
          entry.type !== "File" ||
          entry.size > limit ||
          entry.mode === undefined ||
          entry.mode & 0o077
        ) {
          invalid = true;
          entry.resume();
          return;
        }
        seen.add(entry.path);
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => {
          return chunks.push(chunk);
        });
        entry.on("end", () => {
          contents.set(entry.path, Buffer.concat(chunks));
        });
      },
    });
    const ended = once(parser, "end");
    parser.end(archive);
    await ended;
    if (invalid || !seen.has("execution.json"))
      throw new PlanningError("InvalidProductionPackageContents");
    for (const [path, content] of contents)
      await writePrivate(join(directory, path), content);
    complete = true;
  } finally {
    if (!complete) await rm(directory, { recursive: true, force: true });
  }
}
