import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sshCommand } from "../index";

const helper = vi.hoisted(() => {
  return {
    mode: "normal",
    discovered: undefined as (() => void) | undefined,
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
      const host='a0000000-0000-4000-8000-000000000001',run='b0000000-0000-4000-8000-000000000001';
      const frame=bytes=>{const h=Buffer.alloc(4);h.writeUInt32BE(bytes.length);return Buffer.concat([h,bytes]);};
      let pending=Buffer.alloc(0),request,done=false;
      const emit=value=>{const b=Buffer.from(JSON.stringify(value));process.stdout.write(binary?frame(b):Buffer.concat([b,Buffer.from([10])]));};
      function reply(){
        if(done)return;done=true;process.send(request);
        if(request.method==='ssh.diagnostics.capabilities'){
          if(mode==='hold_discovery'){setInterval(()=>{},1000);return;}
          if(mode==='old'){emit({type:'error',code:'unknown_method',delivery:'not_dispatched'});process.stdout.end(()=>process.exit(1));return;}
          emit({type:'result',data:{schema_version:2,passive_query:mode!=='disabled',automatic_methods:mode==='disabled'?[]:['ssh.exec','ssh.file.upload','ssh.file.download','ssh.session.start','ssh.session.status','ssh.session.read','ssh.session.write','ssh.session.signal','ssh.session.close'].map(m=>m+'.diagnostics.v2'),query_method:'ssh.diagnostics.query.v2'}});
          process.stdout.end(()=>process.exit(0));return;
        }
        const versioned=request.method.endsWith('.diagnostics.v2'), method=request.method.replace('.diagnostics.v2','');
        const file=method.startsWith('ssh.file.'),session=method.startsWith('ssh.session.');
        let report={schema_version:2,run_id:run,assignment_id:run,attempt_id:'c0000000-0000-4000-8000-000000000001',sequence:1,observed_at:'2026-10-15T00:00:00Z',protocol:'ssh',connection_id:host,session_id:request.params.sessionId??null,configuration_created_at:'2026-09-01T00:00:00.123456Z',configuration_generation:7,operation:file?'file':session?'session':'exec',stage:'ssh_operation',cause:{source:'ssh',code:'authentication_failed'},dependencies:[],native:null,detail:'not_observed',truncated:false,next_action:'check_credential',ssh:{access_failure:null,route:'direct',transport:'fresh',selected_address:'93.184.216.34',address_family:'ipv4',stages:[{stage:'authentication',status:'failed'}]}};
        if(mode==='foreign')report.connection_id=run;
        if(mode==='malformed')report.provider='secret-canary';
        if(mode==='version')report.schema_version=99;
        if(request.method==='ssh.diagnostics.query.v2'){
          emit({type:'result',data:{schema_version:2,status:'found',report,retention:{capacity:64,evicted:0,latest_failure_pinned:true}}});
          process.stdout.end(()=>process.exit(0));return;
        }
        let data={type:'failed',failure_reason:'authentication_failed',effects:'not_started'};
        if(file)data={...data,direction:method.includes('download')?'download':'upload',ssh_connection_id:host,bytes:0,sha256:null,residue:null,actual_bytes:request.params.size??null,limits:{max_file_bytes:1073741824,timeout_ms:900000,max_concurrent_transfers:2}};
        else if(session&&['ssh.session.status','ssh.session.read'].includes(method)){
          data={type:method.endsWith('read')?'read':'status',session:{session_id:request.params.sessionId,ssh_connection_id:host,generation:7,state:{type:'failed',failure_reason:'authentication_failed'},effects:'not_started',stdin_closed:false,oldest_cursor:0,end_cursor:0}};
          if(method.endsWith('read'))Object.assign(data,{wait_expired:false,chunks:[],next_cursor:0});
        }else if(!session)Object.assign(data,{stdout_bytes:0,stderr_bytes:0,stdout_truncated:false,stderr_truncated:false});
        if(mode==='nonzero'){
          emit({type:'event',data:{type:'accepted'}});data={type:'finished',exit:{type:'status',code:9},effects:'completed',stdout_bytes:0,stderr_bytes:0,stdout_truncated:false,stderr_truncated:false};
        }else if(versioned&&mode!=='missing')data.diagnostics={status:'found',report};
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
        if (
          parsed &&
          "method" in parsed &&
          parsed.method === "ssh.diagnostics.capabilities"
        )
          helper.discovered?.();
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
  helper.discovered = undefined;
  helper.requests.length = 0;
  output.mockClear();
  errors.mockClear();
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
function business() {
  return helper.requests.filter((r) => {
    return r.method !== "ssh.diagnostics.capabilities";
  });
}

it("queries the negotiated versioned passive report with exact selectors", async () => {
  const attempt = "c0000000-0000-4000-8000-000000000001";
  await sshCommand.parseAsync(
    ["diagnose", host, "--attempt-id", attempt, "--json"],
    {
      from: "user",
    },
  );
  expect(result()).toMatchObject({
    schema_version: 2,
    status: "found",
    report: { attempt_id: attempt, next_action: "check_credential" },
  });
  expect(business()).toEqual([
    {
      method: "ssh.diagnostics.query.v2",
      params: { connectionId: host, attemptId: attempt },
    },
  ]);
});

it.each(["exec", "session", "file"])(
  "attaches the exact owner report for %s without a host-latest query",
  async (kind) => {
    if (kind === "exec") await exec();
    else if (kind === "session")
      await sshCommand.parseAsync(["session", "status", session, "--json"], {
        from: "user",
      });
    else {
      const path = join(dir, "source");
      await writeFile(path, "test");
      await sshCommand.parseAsync(["upload", host, path, "/remote", "--json"], {
        from: "user",
      });
    }
    expect(result()).toMatchObject({
      diagnostics: {
        status: "found",
        report: {
          attempt_id: "c0000000-0000-4000-8000-000000000001",
          connection_id: host,
          next_action: "check_credential",
        },
      },
    });
    expect(business()).toHaveLength(1);
    expect(business()[0]?.method).toContain(".diagnostics.v2");
    expect(
      helper.requests.some((r) => {
        return r.method.includes("query") || r.method === "ssh.diagnose";
      }),
    ).toBe(false);
  },
);
it("prints cause-specific next action in human output", async () => {
  await exec(false);
  expect(errors.mock.calls.flat().join(" ")).toContain(
    "Check the configured SSH credential",
  );
  expect(errors.mock.calls.flat().join(" ")).toContain(
    "c0000000-0000-4000-8000-000000000001",
  );
});
it.each(["old", "disabled"])(
  "executes business once with unavailable diagnostics for %s owners",
  async (mode) => {
    helper.mode = mode;
    await exec();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "authentication_failed",
      effects: "not_started",
      diagnostics: { status: "unavailable" },
    });
    expect(business()).toHaveLength(1);
    expect(business()[0]?.method).toBe("ssh.exec");
  },
);
it.each(["malformed", "foreign", "version", "missing"])(
  "keeps valid business outcomes when diagnostics are %s",
  async (mode) => {
    helper.mode = mode;
    await exec();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "authentication_failed",
      effects: "not_started",
      diagnostics: { status: "unavailable" },
    });
    expect(JSON.stringify(output.mock.calls)).not.toContain("secret-canary");
    expect(business()).toHaveLength(1);
  },
);
it.each(["duplicate", "exit", "bad_business"])(
  "does not trust association after %s business delivery",
  async (mode) => {
    helper.mode = mode;
    await exec();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "protocol",
      effects: "unknown",
      diagnostics: { status: "unavailable" },
    });
    expect(business()).toHaveLength(1);
  },
);
it.each(["exec", "file"])(
  "cancellation during %s discovery cannot start business work",
  async (kind) => {
    helper.mode = "hold_discovery";
    const ready = new Promise<void>((resolve) => {
      helper.discovered = resolve;
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
      effects: "not_started",
      diagnostics: { status: "unavailable", reason: "cancelled" },
    });
    expect(business()).toHaveLength(0);
  },
);

it("preserves a completed nonzero remote exit without a failure report", async () => {
  helper.mode = "nonzero";
  await exec();
  expect(result()).toMatchObject({
    type: "finished",
    exit: { code: 9 },
    effects: "completed",
  });
  expect(result()).not.toHaveProperty("diagnostics");
  expect(process.exitCode).toBe(9);
  expect(business()).toHaveLength(1);
});
