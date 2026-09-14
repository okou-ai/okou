import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { FILE_LIMITS, FileError, type FileReason } from "./file-protocol";

export function fileReason(error: unknown): FileReason {
  if (error instanceof FileError) return error.reason;
  if (error instanceof Error && "code" in error) {
    switch (error.code) {
      case "ENOENT":
        return "path_not_found";
      case "EACCES":
      case "EPERM":
        return "permission_denied";
      case "EEXIST":
        return "destination_exists";
      case "ELOOP":
      case "EISDIR":
      case "ENOTDIR":
        return "not_regular_file";
    }
  }
  return "local_io";
}

export function validateFilePath(path: string) {
  if (
    !path ||
    Buffer.byteLength(path) > 4096 ||
    path.includes("\0") ||
    ["", ".", ".."].includes(path.split("/").at(-1) ?? "")
  )
    throw new FileError("invalid_path");
}

function sameFile(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino;
}
function unchanged(a: BigIntStats, b: BigIntStats) {
  return (
    sameFile(a, b) &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

export class UploadSource {
  private file: FileHandle | undefined;
  private before: BigIntStats | undefined;
  size = 0;
  bytes = 0;
  sha256: string | undefined;
  async init(path: string) {
    validateFilePath(path);
    this.file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    this.before = await this.file.stat({ bigint: true });
    if (!this.before.isFile()) throw new FileError("not_regular_file");
    this.size = Number(this.before.size);
    if (this.before.size > BigInt(FILE_LIMITS.max_file_bytes))
      throw new FileError("file_too_large");
  }
  async send(write: (bytes: Buffer) => Promise<void>, signal: AbortSignal) {
    if (!this.file || !this.before) throw new FileError("local_io");
    const buffer = Buffer.alloc(32768);
    const hash = createHash("sha256");
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await this.file.read(
        buffer,
        0,
        buffer.length,
        null,
      );
      if (!bytesRead) break;
      if (this.bytes + bytesRead > this.size)
        throw new FileError("source_changed");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await write(chunk);
      this.bytes += bytesRead;
    }
    if (
      this.bytes !== this.size ||
      !unchanged(this.before, await this.file.stat({ bigint: true }))
    )
      throw new FileError("source_changed");
    this.sha256 = hash.digest("hex");
  }
  async close() {
    await this.file?.close();
  }
}

export class DownloadDestination {
  private parent: FileHandle | undefined;
  private directory: FileHandle | undefined;
  private file: FileHandle | undefined;
  private directoryIdentity: BigIntStats | undefined;
  private fileIdentity: BigIntStats | undefined;
  private target = "";
  private stage = "";
  private data = "";
  private fileExists = false;
  private readonly hash = createHash("sha256");
  bytes = 0;
  residue: string | null = null;
  constructor(
    private readonly path: string,
    private readonly overwrite: boolean,
  ) {}

  async init() {
    validateFilePath(this.path);
    this.parent = await open(
      dirname(this.path),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    const anchoredParent = `/proc/self/fd/${this.parent.fd}`;
    this.target = `${anchoredParent}/${basename(this.path)}`;
    await this.checkTarget();
    const name = `.okou-transfer-${randomUUID()}`;
    this.stage = `${anchoredParent}/${name}`;
    await mkdir(this.stage, { mode: 0o700 });
    this.residue = `${dirname(this.path)}/${name}`;
    this.directory = await open(
      this.stage,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    this.directoryIdentity = await this.directory.stat({ bigint: true });
    this.data = `/proc/self/fd/${this.directory.fd}/data`;
    this.file = await open(
      this.data,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    this.fileExists = true;
    this.fileIdentity = await this.file.stat({ bigint: true });
  }

  private async checkTarget() {
    let stat;
    try {
      stat = await lstat(this.target);
    } catch (error) {
      if (fileReason(error) !== "path_not_found") throw error;
    }
    if (stat && !stat.isFile()) throw new FileError("not_regular_file");
    if (stat && !this.overwrite) throw new FileError("destination_exists");
  }

  async write(bytes: Buffer, signal: AbortSignal) {
    if (!this.file) throw new FileError("local_io");
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesWritten } = await this.file.write(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!bytesWritten) throw new FileError("local_io");
      offset += bytesWritten;
    }
    this.hash.update(bytes);
    this.bytes += bytes.length;
  }

  async publish(size: number, sha256: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.bytes !== size || this.hash.digest("hex") !== sha256)
      throw new FileError("protocol");
    await this.checkIdentity();
    await this.checkTarget();
    signal.throwIfAborted();
    if (this.overwrite) {
      await rename(this.data, this.target);
      this.fileExists = false;
    } else await link(this.data, this.target);
  }

  private async checkIdentity() {
    if (
      !this.directoryIdentity ||
      !sameFile(
        this.directoryIdentity,
        await lstat(this.stage, { bigint: true }),
      ) ||
      !this.fileIdentity ||
      !sameFile(this.fileIdentity, await lstat(this.data, { bigint: true }))
    )
      throw new FileError("local_io");
  }

  async close() {
    try {
      if (
        this.directoryIdentity &&
        sameFile(
          this.directoryIdentity,
          await lstat(this.stage, { bigint: true }),
        )
      ) {
        if (this.fileExists) {
          await this.checkIdentity();
          await unlink(this.data);
          this.fileExists = false;
        }
        await rmdir(this.stage);
        this.residue = null;
      }
    } finally {
      await Promise.all([
        this.file?.close(),
        this.directory?.close(),
        this.parent?.close(),
      ]);
    }
  }
}
