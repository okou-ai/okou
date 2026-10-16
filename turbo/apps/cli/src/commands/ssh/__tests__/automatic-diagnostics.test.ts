import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sshCommand } from "../index";

const helper = vi.hoisted(() => {
  return {
    mode: "normal",
    dispatched: undefined as (() => void) | undefined,
    requests: [] as { method: string; params: Record<string, unknown> }[],
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn((file: string, args: string[]) => {
      expect(file).toBe("/usr/local/bin/runner-rpc-client");
      const child = original.spawn(
        process.execPath,
        [
          "-e",
          `
      const mode=process.env.DIAGNOSTIC_MODE, binary=process.env.DIAGNOSTIC_BINARY==='1';
      const host='a0000000-0000-4000-8000-000000000001';
      const frame=bytes=>{const h=Buffer.alloc(4);h.writeUInt32BE(bytes.length);return Buffer.concat([h,bytes]);};
      let pending=Buffer.alloc(0),request,done=false;
      const emit=value=>{const b=Buffer.from(JSON.stringify(value));process.stdout.write(binary?frame(b):Buffer.concat([b,Buffer.from([10])]));};
      function reply(){
        if(done)return;done=true;process.send(request);
        if(mode==='hold'){setInterval(()=>{},1000);return;}
        if(mode==='old'&&request.params.diagnosticText!==undefined){emit({type:'error',code:'invalid_request',delivery:'not_dispatched'});process.stdout.end(()=>process.exit(1));return;}
        const method=request.method, file=method.startsWith('ssh.file.'),session=method.startsWith('ssh.session.');
        let data={type:'failed',failure_reason:'authentication_failed',effects:'not_started'};
        if(file)data={...data,direction:method.includes('download')?'download':'upload',ssh_connection_id:host,bytes:0,sha256:null,residue:null,actual_bytes:request.params.size??null,limits:{max_file_bytes:1073741824,timeout_ms:900000,max_concurrent_transfers:2}};
        else if(session&&['ssh.session.status','ssh.session.read'].includes(method)){
          data={type:method.endsWith('read')?'read':'status',session:{session_id:request.params.sessionId,ssh_connection_id:host,generation:7,state:{type:'failed',failure_reason:'authentication_failed'},effects:'not_started',stdin_closed:false,oldest_cursor:0,end_cursor:0}};
          if(method.endsWith('read'))Object.assign(data,{wait_expired:false,chunks:[],next_cursor:0});
        }else if(!session)Object.assign(data,{stdout_bytes:0,stderr_bytes:0,stdout_truncated:false,stderr_truncated:false});
        if(mode==='nonzero'){
          emit({type:'event',data:{type:'accepted'}});data={type:'finished',exit:{type:'status',code:9},effects:'completed',stdout_bytes:0,stderr_bytes:0,stdout_truncated:false,stderr_truncated:false};
        }else if(request.params.diagnosticText&& !['missing','disabled'].includes(mode)){
          data.diagnostic_text=mode==='malformed'?{unexpected:true}:mode==='oversized'?'x'.repeat(8193):mode==='unsafe'?String.fromCharCode(27)+'[2J':process.env.DIAGNOSTIC_TEXT;
        }
        if(mode==='bad_business')data.effects='completed';
        if(binary&&method.includes('download'))process.stdout.write(frame(Buffer.from([1])));
        emit({type:'result',data});
        if(mode==='duplicate')emit({type:'result',data});
        process.stdout.end(()=>process.exit(mode==='exit'?1:0));
      }
      process.stdin.on('data',chunk=>{
        pending=Buffer.concat([pending,chunk]);
        if(binary){while(pending.length>=4&&pending.length>=4+pending.readUInt32BE()){
          const n=pending.readUInt32BE(),b=pending.subarray(4,4+n);pending=pending.subarray(4+n);
          if(!request)request=JSON.parse(b.toString());else if(b[0]===1)reply();
        }}
      });
      process.stdin.on('end',()=>{if(!binary){request=JSON.parse(pending.toString());reply();}});
    `,
        ],
        {
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: {
            ...process.env,
            DIAGNOSTIC_MODE: helper.mode,
            DIAGNOSTIC_BINARY: args.includes("--stream") ? "1" : "0",
          },
        },
      );
      child.on("message", (message: unknown) => {
        const parsed =
          typeof message === "object" && message !== null ? message : undefined;
        if (
          parsed &&
          "method" in parsed &&
          typeof parsed.method === "string" &&
          "params" in parsed
        )
          helper.requests.push({
            method: parsed.method,
            params:
              typeof parsed.params === "object" && parsed.params !== null
                ? Object.fromEntries(Object.entries(parsed.params))
                : {},
          });
        helper.dispatched?.();
      });
      return child;
    }),
  };
});
const host = "a0000000-0000-4000-8000-000000000001",
  run = "b0000000-0000-4000-8000-000000000001",
  session = "d0000000-0000-4000-8000-000000000001";
const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ssh-diagnostic-"));
  helper.mode = "normal";
  helper.dispatched = undefined;
  helper.requests.length = 0;
  output.mockClear();
  errors.mockClear();
  vi.stubEnv("OKOU_REMOTE_DIAGNOSTIC_TEXT", "1");
  vi.stubEnv(
    "DIAGNOSTIC_TEXT",
    "An arbitrary Runner explanation: credential rejected. 认证失败 🧭",
  );
  vi.stubEnv(
    "OKOU_TOKEN",
    `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities: ["ssh:read", "ssh:write"], runId: run })).toString("base64url")}.signature`,
  );
  for (const command of [
    sshCommand,
    ...sshCommand.commands,
    ...(sshCommand.commands.find((c) => {
      return c.name() === "session";
    })?.commands ?? []),
    ...(sshCommand.commands.find((c) => {
      return c.name() === "file";
    })?.commands ?? []),
  ])
    for (const option of command.options)
      command.setOptionValue(option.attributeName(), option.defaultValue);
});
afterEach(async () => {
  process.exitCode = 0;
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
async function exec(json = true) {
  await sshCommand.parseAsync(
    ["exec", host, "--command", "safe command", ...(json ? ["--json"] : [])],
    { from: "user" },
  );
}
function result(): unknown {
  return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
}
it.each(["exec", "session", "upload", "download"])(
  "passes Runner text unchanged for %s with one business request",
  async (kind) => {
    if (kind === "exec") await exec();
    else if (kind === "session")
      await sshCommand.parseAsync(["session", "status", session, "--json"], {
        from: "user",
      });
    else if (kind === "upload") {
      const path = join(dir, "source");
      await writeFile(path, "test");
      await sshCommand.parseAsync(["upload", host, path, "/remote", "--json"], {
        from: "user",
      });
    } else
      await sshCommand.parseAsync(
        ["download", host, "/remote", join(dir, "output"), "--json"],
        { from: "user" },
      );
    expect(result()).toMatchObject({
      diagnostic_text:
        "An arbitrary Runner explanation: credential rejected. 认证失败 🧭",
    });
    expect(helper.requests).toHaveLength(1);
    expect(helper.requests[0]?.params.diagnosticText).toBe(true);
    expect(helper.requests[0]?.method).toBe(
      kind === "exec"
        ? "ssh.exec"
        : kind === "session"
          ? "ssh.session.status"
          : `ssh.file.${kind}`,
    );
  },
);
it("prints Runner wording unchanged in human output", async () => {
  await exec(false);
  expect(errors).toHaveBeenCalledWith(
    "An arbitrary Runner explanation: credential rejected. 认证失败 🧭",
  );
  expect(helper.requests).toHaveLength(1);
});
it.each(["old", "disabled", "missing"])(
  "preserves the original failure without diagnostic text on %s owners",
  async (mode) => {
    helper.mode = mode;
    if (mode === "old") vi.stubEnv("OKOU_REMOTE_DIAGNOSTIC_TEXT", "");
    await exec();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "authentication_failed",
      effects: "not_started",
    });
    expect(result()).not.toHaveProperty("diagnostic_text");
    expect(helper.requests).toHaveLength(1);
    expect(helper.requests[0]?.method).toBe("ssh.exec");
    if (mode === "old")
      expect(helper.requests[0]?.params).not.toHaveProperty("diagnosticText");
  },
);
it.each(["malformed", "oversized", "unsafe"])(
  "keeps a verified business failure when explanation text is %s",
  async (mode) => {
    helper.mode = mode;
    await exec();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "authentication_failed",
      effects: "not_started",
    });
    expect(result()).not.toHaveProperty("diagnostic_text");
    expect(helper.requests).toHaveLength(1);
  },
);
it.each(["duplicate", "exit", "bad_business"])(
  "discards diagnostic text after %s business delivery",
  async (mode) => {
    helper.mode = mode;
    await exec();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "protocol",
      effects: "unknown",
    });
    expect(result()).not.toHaveProperty("diagnostic_text");
    expect(helper.requests).toHaveLength(1);
  },
);
it.each(["exec", "file"])(
  "cancels an in-flight %s request without replay",
  async (kind) => {
    helper.mode = "hold";
    const ready = new Promise<void>((resolve) => {
      helper.dispatched = resolve;
    });
    const path = join(dir, "cancelled-source");
    await writeFile(path, "test");
    const work =
      kind === "exec"
        ? exec()
        : sshCommand.parseAsync(["upload", host, path, "/remote", "--json"], {
            from: "user",
          });
    await ready;
    process.emit("SIGINT");
    await work;
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "cancelled",
      effects: "unknown",
    });
    expect(result()).not.toHaveProperty("diagnostic_text");
    expect(helper.requests).toHaveLength(1);
  },
);
it("preserves a completed nonzero remote exit", async () => {
  helper.mode = "nonzero";
  await exec();
  expect(result()).toMatchObject({
    type: "finished",
    exit: { code: 9 },
    effects: "completed",
  });
  expect(result()).not.toHaveProperty("diagnostic_text");
  expect(process.exitCode).toBe(9);
  expect(helper.requests).toHaveLength(1);
});
