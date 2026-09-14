import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rm,
  symlink,
  stat,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sshCommand } from "../index";

const helper = vi.hoisted(() => {
  return {
    mode: "normal",
    data: "",
    ready: undefined as (() => void) | undefined,
    requests: [] as unknown[],
    mutate: "",
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn((file: string, args: string[]) => {
      expect(file).toBe("/usr/local/bin/runner-rpc-client");
      expect(args).toEqual(["--stream"]);
      const script = `
      const crypto = require('node:crypto'), fs = require('node:fs');
      const mode = process.env.SSH_FILE_MODE;
      const limits = {max_file_bytes:1073741824,timeout_ms:900000,max_concurrent_transfers:2};
      let pending = Buffer.alloc(0), request, bytes = 0;
      const hash = crypto.createHash('sha256');
      const frame = data => { const header = Buffer.alloc(4); header.writeUInt32BE(data.length); return Buffer.concat([header,data]); };
      const emit = data => process.stdout.write(frame(data));
      const reply = value => emit(Buffer.from(JSON.stringify(value)));
      function complete() {
        const download = request.method.endsWith('download');
        const body = Buffer.from(process.env.SSH_FILE_DATA, 'base64');
        const size = download ? body.length : bytes;
        const digest = download ? crypto.createHash('sha256').update(body).digest('hex') : hash.digest('hex');
        const result = {type:'completed',direction: download ? 'download':'upload',ssh_connection_id:request.params.sshConnectionId,
          bytes:size,sha256:digest,effects:download?'not_started':'completed',failure_reason:null,residue:null,actual_bytes:size,limits};
        if (mode === 'hang') { process.send('ready'); setInterval(()=>{},1000); return; }
        if (mode === 'oversized') { process.stdout.end(Buffer.from([255,255,255,255])); return; }
        if (download && body.length) for(let i=0;i<body.length;i+=32768) emit(Buffer.concat([Buffer.from([0]),body.subarray(i,i+32768)]));
        if (download && mode !== 'no-end') emit(Buffer.from([1]));
        if (mode === 'digest') result.sha256 = '0'.repeat(64);
        if (mode === 'partial') { result.type='failed'; result.sha256=null; result.failure_reason='source_changed'; }
        if (mode === 'identity') result.ssh_connection_id='b0000000-0000-4000-8000-000000000001';
        reply({type:'result',data:result});
        if(mode === 'duplicate') reply({type:'result',data:result});
        if(mode === 'exit') process.exitCode = 1;
        process.stdout.end();
        if(mode === 'close-gate') { process.send('ready'); process.on('message',()=>process.exit(0)); setInterval(()=>{},1000); }
        else process.disconnect();
      }
      process.stdin.on('data', chunk => {
        pending = Buffer.concat([pending,chunk]);
        while(pending.length>=4 && pending.length>=4+pending.readUInt32BE()) {
          const size=pending.readUInt32BE(), payload=pending.subarray(4,4+size); pending=pending.subarray(4+size);
          if(!request) {
            request=JSON.parse(payload.toString()); process.send(request);
            if(process.env.SSH_FILE_MUTATE) fs.truncateSync(process.env.SSH_FILE_MUTATE,0);
            if(mode === 'early-closed') {
              process.stdin.destroy(); fs.closeSync(0);
              process.on('message',()=>{
                reply({type:'result',data:{type:'failed',direction:'upload',ssh_connection_id:request.params.sshConnectionId,
                  bytes:0,sha256:null,effects:'not_started',failure_reason:'destination_exists',residue:null,actual_bytes:request.params.size,limits}});
                process.stdout.end(()=>process.exit(0));
              });
              return;
            }
            if(mode === 'early') { reply({type:'error',code:'unknown_method',delivery:'not_dispatched'}); process.stdout.end(()=>process.exit(1)); return; }
          } else if(payload[0]===0) { hash.update(payload.subarray(1)); bytes+=payload.length-1; }
          else { complete(); }
        }
      });
    `;
      const child =
        helper.mode === "missing"
          ? original.spawn("/nonexistent/file-test-helper", [], {
              stdio: ["pipe", "pipe", "pipe"],
            })
          : original.spawn(process.execPath, ["-e", script], {
              stdio: ["pipe", "pipe", "pipe", "ipc"],
              env: {
                ...process.env,
                SSH_FILE_MODE: helper.mode,
                SSH_FILE_DATA: helper.data,
                SSH_FILE_MUTATE: helper.mutate,
              },
            });
      child.on("message", (message: unknown) => {
        if (message === "ready") helper.ready?.();
        else helper.requests.push(message);
      });
      if (helper.mode === "early-closed") {
        if (!child.stdin) throw new Error("Expected piped helper input");
        child.stdin.on("error", () => {
          if (child.connected) child.send("reject");
        });
      }
      children.push(child);
      return child;
    }),
  };
});

const id = "a0000000-0000-4000-8000-000000000001";
const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});
let dir: string;
const children: ReturnType<typeof spawn>[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "okou-ssh-files-"));
  vi.stubEnv(
    "OKOU_TOKEN",
    `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities: ["ssh:write"], userId: "owner", orgId: "org", runId: id })).toString("base64url")}.signature`,
  );
  helper.mode = "normal";
  helper.data = "";
  helper.mutate = "";
  helper.requests.length = 0;
  helper.ready = undefined;
  vi.mocked(spawn).mockClear();
  for (const command of sshCommand.commands)
    for (const option of command.options)
      command.setOptionValue(option.attributeName(), option.defaultValue);
});
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid)
        return;
      const closed = new Promise<void>((resolve) => {
        child.once("close", resolve);
      });
      child.kill("SIGKILL");
      await closed;
    }),
  );
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  output.mockClear();
  errors.mockClear();
  process.exitCode = 0;
  vi.useRealTimers();
});
async function invoke(
  direction: "upload" | "download",
  path: string,
  ...extra: string[]
) {
  const paths =
    direction === "upload"
      ? [path, "/remote literal $file"]
      : ["/remote literal $file", path];
  await sshCommand.parseAsync([direction, id, ...paths, "--json", ...extra], {
    from: "user",
  });
  return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
}

it.each([0, 258, 4 * 1024 * 1024 + 19])(
  "uploads a regular file once, hashing streamed bytes: %i",
  async (size) => {
    const path = join(dir, "source");
    const bytes = Buffer.alloc(size, 0xff);
    await writeFile(path, bytes);
    const result = await invoke("upload", path);
    expect(result).toMatchObject({
      type: "completed",
      bytes: size,
      effects: "completed",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(helper.requests).toEqual([
      {
        version: 1,
        method: "ssh.file.upload",
        params: {
          sshConnectionId: id,
          remotePath: "/remote literal $file",
          size,
          overwrite: false,
        },
      },
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
  },
);

it.each(["normal", "overwrite"])(
  "downloads binary data into an atomic private file: %s",
  async (mode) => {
    const path = join(dir, "target");
    const bytes = Buffer.from([0, 255, 240, 1]);
    helper.data = bytes.toString("base64");
    if (mode === "overwrite") await writeFile(path, "original");
    const result = await invoke(
      "download",
      path,
      ...(mode === "overwrite" ? ["--overwrite"] : []),
    );
    expect(result).toMatchObject({
      type: "completed",
      effects: "completed",
      residue: null,
    });
    expect(await readFile(path)).toEqual(bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["target"]);
  },
);

it.each([
  "digest",
  "no-end",
  "duplicate",
  "identity",
  "oversized",
  "partial",
  "exit",
])("does not publish on %s helper failure", async (mode) => {
  helper.mode = mode;
  helper.data = Buffer.from("new bytes").toString("base64");
  const path = join(dir, "target");
  await writeFile(path, "original");
  const result = await invoke("download", path, "--overwrite");
  expect(result).toMatchObject({
    type: "failed",
    effects: "not_started",
    residue: null,
  });
  expect(await readFile(path, "utf8")).toBe("original");
  expect(await readdir(dir)).toEqual(["target"]);
});

it("waits for helper exit before publishing", async () => {
  helper.mode = "close-gate";
  const ready = new Promise<void>((resolve) => {
    helper.ready = resolve;
  });
  const path = join(dir, "target");
  const work = invoke("download", path);
  await ready;
  const child = vi.mocked(spawn).mock.results[0]?.value;
  if (!child) throw new Error("Expected helper");
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  child.send("release");
  expect(await work).toMatchObject({ type: "completed" });
  expect(await readFile(path)).toEqual(Buffer.alloc(0));
});

it.each(["early", "missing"])(
  "reports unsupported helper and stops a backpressured upload: %s",
  async (mode) => {
    helper.mode = mode;
    const path = join(dir, "source");
    await writeFile(path, Buffer.alloc(4 * 1024 * 1024));
    expect(await invoke("upload", path)).toMatchObject({
      type: "failed",
      effects: "not_started",
      failure_reason:
        mode === "early" ? "unsupported_operation" : "helper_unavailable",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  },
);

it("preserves an early file rejection after the helper closes upload input", async () => {
  helper.mode = "early-closed";
  const path = join(dir, "source");
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024));
  expect(await invoke("upload", path)).toMatchObject({
    type: "failed",
    effects: "not_started",
    failure_reason: "destination_exists",
  });
});

it("aborts a changing source without sending completion", async () => {
  const path = join(dir, "source");
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024));
  helper.mutate = path;
  expect(await invoke("upload", path)).toMatchObject({
    type: "failed",
    failure_reason: "source_changed",
  });
});

it("kills and joins the helper on SIGINT without publishing a destination", async () => {
  helper.mode = "hang";
  const ready = new Promise<void>((resolve) => {
    helper.ready = resolve;
  });
  const listeners = process.listenerCount("SIGINT");
  const work = invoke("download", join(dir, "target"));
  await ready;
  process.emit("SIGINT");
  expect(await work).toMatchObject({
    type: "failed",
    failure_reason: "cancelled",
    effects: "not_started",
  });
  expect(await readdir(dir)).toEqual([]);
  expect(process.listenerCount("SIGINT")).toBe(listeners);
});

it("enforces the 15-minute total helper lifetime without a timeout override", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  helper.mode = "hang";
  const ready = new Promise<void>((resolve) => {
    helper.ready = resolve;
  });
  const work = invoke("download", join(dir, "target"));
  await ready;
  vi.advanceTimersByTime(900_000);
  expect(await work).toMatchObject({
    type: "failed",
    failure_reason: "timed_out",
    effects: "not_started",
    limits: { timeout_ms: 900_000 },
  });
  expect(await readdir(dir)).toEqual([]);
});

it("rejects local symlinks and conflicts before dispatch", async () => {
  const path = join(dir, "original");
  await writeFile(path, "unchanged");
  const linked = join(dir, "symlink");
  await symlink(path, linked);
  expect(await invoke("upload", linked)).toMatchObject({
    failure_reason: "not_regular_file",
  });
  expect(await invoke("download", linked, "--overwrite")).toMatchObject({
    failure_reason: "not_regular_file",
  });
  expect(await invoke("download", path)).toMatchObject({
    failure_reason: "destination_exists",
  });
  expect(await readFile(path, "utf8")).toBe("unchanged");
  expect(spawn).not.toHaveBeenCalled();
});

it("explains all fixed limits in help and an oversized-file error", async () => {
  for (const command of [
    sshCommand,
    ...sshCommand.commands.filter((command) => {
      return ["upload", "download"].includes(command.name());
    }),
  ]) {
    let help = "";
    command.configureOutput({
      writeOut: (text) => {
        help += text;
      },
    });
    command.outputHelp();
    expect(help).toContain("1 GiB (1,073,741,824 bytes) per file");
    expect(help).toContain("15 minutes total per helper invocation");
    expect(help).toContain("2 simultaneous transfers per Run");
    expect(help).toContain("No option overrides");
  }
  const path = join(dir, "huge");
  await writeFile(path, "");
  await truncate(path, 1_073_741_825);
  expect(await invoke("upload", path)).toMatchObject({
    type: "failed",
    failure_reason: "file_too_large",
    actual_bytes: 1_073_741_825,
    limits: {
      max_file_bytes: 1_073_741_824,
      timeout_ms: 900_000,
      max_concurrent_transfers: 2,
    },
    guidance: expect.stringContaining("Split"),
  });
  expect(spawn).not.toHaveBeenCalled();
});
