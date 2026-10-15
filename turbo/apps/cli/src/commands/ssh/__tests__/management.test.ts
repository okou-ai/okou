import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { sshCommand } from "../index";

const base = "http://localhost:3000";
const id = "a0000000-0000-4000-8000-000000000001";
const credentialId = "b0000000-0000-4000-8000-000000000001";
const configId = "c0000000-0000-4000-8000-000000000001";
const secrets = {
  username: "secret-login-marker",
  password: "secret-password-marker",
  privateKey: "secret-private-key-marker",
  passphrase: "secret-passphrase-marker",
  clientId: "secret-client-id-marker",
};
const dates = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};
const host = {
  id,
  displayName: "Production",
  host: "ssh.example.com",
  port: 443,
  credentialId,
  credentialName: "Deploy",
  generation: 7,
  learnedHostKey: null,
  ...dates,
  ...secrets,
  transport: { type: "cloudflare_access", configId, ...secrets },
};
const credential = {
  id: credentialId,
  name: "Deploy",
  authMethod: "password",
  revision: 3,
  hosts: [{ id, displayName: "Production", ...secrets }],
  ...dates,
  ...secrets,
};
const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});
let directory: string;

function token(capabilities: string[]) {
  const payload = Buffer.from(
    JSON.stringify({ scope: "okou", capabilities }),
  ).toString("base64url");
  vi.stubEnv("OKOU_TOKEN", `vm0_sandbox_header.${payload}.signature`);
}
function invoke(...args: string[]) {
  return sshCommand.parseAsync(args, { from: "user" });
}
async function input(value: unknown) {
  const path = join(directory, "input.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}
function result(): unknown {
  return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}
function displayed() {
  return [...log.mock.calls, ...error.mock.calls].flat().join("\n");
}
function expectNoSecrets() {
  for (const secret of Object.values(secrets))
    expect(displayed()).not.toContain(secret);
  for (const field of Object.keys(secrets))
    expect(displayed()).not.toContain(`"${field}":`);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "okou-ssh-management-"));
  vi.stubEnv("OKOU_API_BACKEND_URL", base);
  token(["connector:read", "connector:write"]);
  for (const group of sshCommand.commands) {
    for (const command of group.commands) {
      for (const option of command.options)
        command.setOptionValue(option.attributeName(), option.defaultValue);
    }
  }
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  log.mockClear();
  error.mockClear();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

describe("okou ssh management", () => {
  it("lists configured hosts with connector:read, projecting safe nested metadata", async () => {
    token(["connector:read"]);
    server.use(
      http.get(`${base}/api/ssh/connections`, () => {
        return HttpResponse.json({ connections: [host], ...secrets });
      }),
    );
    await invoke("host", "list", "--scope", "configured", "--json");
    expect(result()).toMatchObject({
      connections: [
        {
          id,
          generation: 7,
          transport: { type: "cloudflare_access", configId },
        },
      ],
    });
    expectNoSecrets();
  });

  it("keeps default authorized inventory under ssh:read and omits usernames", async () => {
    token(["ssh:read"]);
    server.use(
      http.get(`${base}/api/ssh/hosts`, () => {
        return HttpResponse.json({
          hosts: [
            {
              id,
              displayName: "Production",
              host: "ssh.example.com",
              port: 22,
              username: secrets.username,
              learnedHostKey: null,
              availability: { status: "ready" },
            },
          ],
        });
      }),
    );
    await invoke("host", "list", "--json");
    expect(result()).toMatchObject({
      hosts: [{ id, availability: { status: "ready" } }],
    });
    expectNoSecrets();
  });

  it.each(["host", "credential"])(
    "shows an exact owned %s through list metadata",
    async (group) => {
      server.use(
        http.get(`${base}/api/ssh/connections`, () => {
          return HttpResponse.json({ connections: [host] });
        }),
        http.get(`${base}/api/ssh/credentials`, () => {
          return HttpResponse.json({ credentials: [credential] });
        }),
      );
      const selected = group === "host" ? id : credentialId;
      await invoke(group, "show", selected, "--json");
      expect(result()).toMatchObject({ id: selected });
      expectNoSecrets();
    },
  );

  it("lists credentials without usernames or reflected success extras", async () => {
    server.use(
      http.get(`${base}/api/ssh/credentials`, () => {
        return HttpResponse.json({ credentials: [credential], ...secrets });
      }),
    );
    await invoke("credential", "list", "--json");
    expect(result()).toMatchObject({
      credentials: [{ id: credentialId, revision: 3, hosts: [{ id }] }],
    });
    expectNoSecrets();
  });

  it("creates a credential with a generated UUID and sends secrets only in the request", async () => {
    let body: unknown;
    server.use(
      http.post(`${base}/api/ssh/credentials`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(credential, { status: 201 });
      }),
    );
    await invoke(
      "credential",
      "create",
      "--input",
      await input({
        name: "Deploy",
        username: secrets.username,
        authentication: { method: "password", password: secrets.password },
      }),
      "--json",
    );
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "Deploy",
      username: secrets.username,
      authentication: { method: "password", password: secrets.password },
    });
    expect(result()).toMatchObject({ id: credentialId, revision: 3 });
    expectNoSecrets();
  });

  it("creates a host with a saved credential and tunnel binding without self-grant fields", async () => {
    let body: unknown;
    server.use(
      http.post(`${base}/api/ssh/connections`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(host, { status: 201 });
      }),
    );
    await invoke(
      "host",
      "create",
      "--input",
      await input({
        displayName: "Production",
        host: "ssh.example.com",
        port: 443,
        credential: { id: credentialId },
        transport: { type: "cloudflare_access", configId },
      }),
      "--json",
    );
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      displayName: "Production",
      host: "ssh.example.com",
      port: 443,
      credential: { id: credentialId },
      transport: { type: "cloudflare_access", configId },
    });
    expect(result()).toMatchObject({ id, generation: 7 });
    expectNoSecrets();
  });

  it("updates a host with the caller's generation and inline credential API shape", async () => {
    let body: unknown;
    server.use(
      http.patch(`${base}/api/ssh/connections/${id}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(host);
      }),
    );
    const update = {
      expectedGeneration: 7,
      credential: {
        create: {
          name: "Deploy",
          username: secrets.username,
          authentication: { method: "password", password: secrets.password },
        },
      },
    };
    await invoke(
      "host",
      "update",
      id,
      "--input",
      await input(update),
      "--json",
    );
    expect(body).toEqual(update);
    expectNoSecrets();
  });

  it("updates credentials with the caller's revision", async () => {
    let body: unknown;
    server.use(
      http.patch(
        `${base}/api/ssh/credentials/${credentialId}`,
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json(credential);
        },
      ),
    );
    const update = {
      expectedRevision: 3,
      authentication: { method: "password", password: secrets.password },
    };
    await invoke(
      "credential",
      "update",
      credentialId,
      "--input",
      await input(update),
      "--json",
    );
    expect(body).toEqual(update);
    expectNoSecrets();
  });

  it("resets a verified host key using its existing generation contract", async () => {
    let body: unknown;
    server.use(
      http.post(
        `${base}/api/ssh/connections/${id}/reset-host-key`,
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json(host);
        },
      ),
    );
    await invoke(
      "host",
      "reset-host-key",
      id,
      "--input",
      await input({ expectedGeneration: 7 }),
      "--json",
    );
    expect(body).toEqual({ expectedGeneration: 7 });
    expectNoSecrets();
  });

  it.each(["file", "stdin"])(
    "deletes a host with the caller's reviewed generation from %s",
    async (source) => {
      const requests: unknown[] = [];
      server.use(
        http.delete(
          `${base}/api/ssh/connections/${id}`,
          async ({ request }) => {
            requests.push(await request.json());
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );
      const stdin = vi.spyOn(process.stdin, Symbol.asyncIterator);
      if (source === "stdin") {
        stdin.mockImplementation(async function* () {
          yield Buffer.from(JSON.stringify({ expectedGeneration: 7 }));
          return undefined;
        });
      }
      try {
        await invoke(
          "host",
          "delete",
          id,
          "--input",
          source === "stdin" ? "-" : await input({ expectedGeneration: 7 }),
          "--json",
        );
      } finally {
        stdin.mockRestore();
      }
      expect(requests).toEqual([{ expectedGeneration: 7 }]);
      expect(result()).toEqual({ id, outcome: "deleted" });
      expectNoSecrets();
    },
  );

  it.each([
    null,
    {},
    { expectedGeneration: 0 },
    { expectedGeneration: -1 },
    { expectedGeneration: 1.5 },
    { expectedGeneration: "7" },
    { expectedGeneration: 2_147_483_648 },
    { expectedGeneration: 7, password: secrets.password },
  ])("rejects invalid deletion input %j before mutation", async (value) => {
    const requests: unknown[] = [];
    server.use(
      http.delete(`${base}/api/ssh/connections/${id}`, async ({ request }) => {
        requests.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(
      invoke("host", "delete", id, "--input", await input(value)),
    ).rejects.toThrow("CLI exit");
    expect(displayed()).toContain("Invalid configuration input");
    expect(requests).toEqual([]);
    expectNoSecrets();
  });

  it("requires explicit deletion input without fetching or mutating the host", async () => {
    const requests: string[] = [];
    server.use(
      http.get(`${base}/api/ssh/connections`, () => {
        requests.push("read");
        return HttpResponse.json({ connections: [host] });
      }),
      http.delete(`${base}/api/ssh/connections/${id}`, () => {
        requests.push("delete");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(invoke("host", "delete", id)).rejects.toThrow("CLI exit");
    expect(requests).toEqual([]);
  });

  it("rejects malformed deletion JSON without reflecting it or mutating", async () => {
    const path = join(directory, "malformed.json");
    await writeFile(path, secrets.privateKey);
    const requests: string[] = [];
    server.use(
      http.delete(`${base}/api/ssh/connections/${id}`, () => {
        requests.push("delete");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(invoke("host", "delete", id, "--input", path)).rejects.toThrow(
      "CLI exit",
    );
    expect(displayed()).toContain("Invalid JSON input");
    expect(requests).toEqual([]);
    expectNoSecrets();
  });

  it("requires explicit review after deletion conflict without fetching or retrying", async () => {
    const requests: unknown[] = [];
    server.use(
      http.get(`${base}/api/ssh/connections`, () => {
        requests.push("read");
        return HttpResponse.json({ connections: [{ ...host, generation: 8 }] });
      }),
      http.delete(`${base}/api/ssh/connections/${id}`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json(
          {
            error: {
              code: "SSH_GENERATION_CONFLICT",
              message: JSON.stringify(secrets),
            },
          },
          { status: 409 },
        );
      }),
    );
    await expect(
      invoke(
        "host",
        "delete",
        id,
        "--input",
        await input({ expectedGeneration: 7 }),
      ),
    ).rejects.toThrow("CLI exit");
    expect(displayed()).toContain("HTTP 409");
    expect(displayed()).toContain(`okou ssh host show ${id}`);
    expect(displayed()).toContain("reviewed expectedGeneration");
    expect(requests).toEqual([{ expectedGeneration: 7 }]);
    expectNoSecrets();
  });

  it("refuses deletion from a read-only Run before reading input or dispatching", async () => {
    token(["connector:read"]);
    const requests: string[] = [];
    server.use(
      http.delete(`${base}/api/ssh/connections/${id}`, () => {
        requests.push("delete");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(
      invoke("host", "delete", id, "--input", "/missing-input-file"),
    ).rejects.toThrow("CLI exit");
    expect(displayed()).toContain("connector:write");
    expect(displayed()).not.toContain("ENOENT");
    expect(requests).toEqual([]);
  });

  it.each([401, 403])(
    "redacts HTTP %s deletion failures and preserves authentication guidance",
    async (status) => {
      server.use(
        http.delete(`${base}/api/ssh/connections/${id}`, () => {
          return HttpResponse.json(
            {
              error: {
                code: secrets.password,
                message: JSON.stringify(secrets),
              },
            },
            { status },
          );
        }),
      );
      await expect(
        invoke(
          "host",
          "delete",
          id,
          "--input",
          await input({ expectedGeneration: 7 }),
        ),
      ).rejects.toThrow("CLI exit");
      expect(displayed()).toContain(`HTTP ${status}`);
      expect(displayed()).toContain("authentication");
      expectNoSecrets();
    },
  );

  it("deletes an unused credential with its expected revision", async () => {
    let body: unknown;
    server.use(
      http.delete(
        `${base}/api/ssh/credentials/${credentialId}`,
        async ({ request }) => {
          body = await request.json();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    await invoke(
      "credential",
      "delete",
      credentialId,
      "--input",
      await input({ expectedRevision: 3 }),
      "--json",
    );
    expect(body).toEqual({ expectedRevision: 3 });
    expect(result()).toEqual({ id: credentialId, outcome: "deleted" });
  });

  it("does not echo secrets when a credential write is rejected", async () => {
    const status = 403;
    server.use(
      http.post(`${base}/api/ssh/credentials`, () => {
        return HttpResponse.json(
          {
            error: {
              message: JSON.stringify(secrets),
              code: secrets.password,
            },
            ...secrets,
          },
          { status },
        );
      }),
    );
    await expect(
      invoke(
        "credential",
        "create",
        "--input",
        await input({
          name: "Deploy",
          username: secrets.username,
          authentication: { method: "password", password: secrets.password },
        }),
      ),
    ).rejects.toThrow("CLI exit");
    expect(displayed()).toContain(`HTTP ${status}`);
    expectNoSecrets();
  });

  it("refuses writes from read-only Runs before reading input or dispatch", async () => {
    token(["connector:read"]);
    await expect(
      invoke("credential", "create", "--input", "/missing-input-file"),
    ).rejects.toThrow("CLI exit");
    expect(displayed()).toContain("connector:write");
    expect(displayed()).not.toContain("ENOENT");
  });

  it("allows owner tokens without a sandbox capability payload", async () => {
    vi.stubEnv("OKOU_TOKEN", "owner-token");
    server.use(
      http.get(`${base}/api/ssh/credentials`, () => {
        return HttpResponse.json({ credentials: [] });
      }),
    );
    await invoke("credential", "list", "--json");
    expect(result()).toEqual({ credentials: [] });
  });
});
