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

  it("does not substitute connector:read for authorized execution inventory", async () => {
    await expect(invoke("host", "list", "--json")).rejects.toThrow("CLI exit");
    expect(displayed()).toContain("ssh:read");
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

  it("accepts credential JSON from stdin without displaying its values", async () => {
    const iterator = vi
      .spyOn(process.stdin, Symbol.asyncIterator)
      .mockImplementation(async function* () {
        yield Buffer.from(
          JSON.stringify({
            name: "Deploy",
            username: secrets.username,
            authentication: { method: "password", password: secrets.password },
          }),
        );
        return undefined;
      });
    server.use(
      http.post(`${base}/api/ssh/credentials`, () => {
        return HttpResponse.json(credential, { status: 201 });
      }),
    );
    try {
      await invoke("credential", "create", "--input", "-", "--json");
      expect(result()).toMatchObject({ id: credentialId });
      expectNoSecrets();
    } finally {
      iterator.mockRestore();
    }
  });

  it("preserves an explicit credential UUID on a no-content create", async () => {
    let body: unknown;
    server.use(
      http.post(`${base}/api/ssh/credentials`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await invoke(
      "credential",
      "create",
      "--input",
      await input({
        id: credentialId,
        name: "Key",
        username: secrets.username,
        authentication: {
          method: "private_key",
          privateKey: secrets.privateKey,
          passphrase: secrets.passphrase,
        },
      }),
      "--json",
    );
    expect(body).toMatchObject({
      id: credentialId,
      authentication: { privateKey: secrets.privateKey },
    });
    expect(result()).toEqual({ id: credentialId, outcome: "created" });
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

  it("deletes hosts without inventing a generation requirement", async () => {
    let text: string | undefined;
    server.use(
      http.delete(`${base}/api/ssh/connections/${id}`, async ({ request }) => {
        text = await request.text();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await invoke("host", "delete", id, "--json");
    expect(text).toBe("");
    expect(result()).toEqual({ id, outcome: "deleted" });
  });

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

  it.each(["malformed", "unknown-top-level", "unknown-nested"])(
    "rejects %s credential input without echoing secrets",
    async (kind) => {
      const path = join(directory, "input.json");
      const value = {
        name: "Deploy",
        username: secrets.username,
        authentication: { method: "password", password: secrets.password },
      };
      if (kind === "malformed")
        await writeFile(path, `{"password":"${secrets.password}",`);
      else
        await writeFile(
          path,
          JSON.stringify(
            kind === "unknown-top-level"
              ? { ...value, clientId: secrets.clientId }
              : {
                  ...value,
                  authentication: {
                    ...value.authentication,
                    privateKey: secrets.privateKey,
                  },
                },
          ),
        );
      await expect(
        invoke("credential", "create", "--input", path),
      ).rejects.toThrow("CLI exit");
      expect(displayed()).toContain("Invalid");
      expectNoSecrets();
    },
  );

  it.each([400, 403, 409, 500])(
    "does not echo reflected API error bodies (HTTP %s)",
    async (status) => {
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
    },
  );

  it("sanitizes malformed reflected response JSON", async () => {
    server.use(
      http.get(`${base}/api/ssh/credentials`, () => {
        return new HttpResponse(`{"password":"${secrets.password}",`, {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    await expect(invoke("credential", "list", "--json")).rejects.toThrow(
      "CLI exit",
    );
    expect(displayed()).toContain("Cannot read SSH management response");
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

  it("does not substitute ssh:read for configured inventory management", async () => {
    token(["ssh:read"]);
    await expect(
      invoke("host", "list", "--scope", "configured", "--json"),
    ).rejects.toThrow("CLI exit");
    expect(displayed()).toContain("connector:read");
  });

  it("reports missing owned IDs without inventing a separate endpoint", async () => {
    server.use(
      http.get(`${base}/api/ssh/connections`, () => {
        return HttpResponse.json({ connections: [] });
      }),
    );
    await expect(invoke("host", "show", id, "--json")).rejects.toThrow(
      "CLI exit",
    );
    expect(displayed()).toContain("SSH host not found");
  });

  it("rejects missing generations and revisions before dispatch", async () => {
    await expect(
      invoke(
        "host",
        "update",
        id,
        "--input",
        await input({ host: "ssh.example.com" }),
      ),
    ).rejects.toThrow("CLI exit");
    await expect(
      invoke("credential", "delete", credentialId, "--input", await input({})),
    ).rejects.toThrow("CLI exit");
    expect(displayed()).toContain("Invalid configuration input");
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

  it("rejects access-grant fields in host input", async () => {
    await expect(
      invoke(
        "host",
        "create",
        "--input",
        await input({
          displayName: "Production",
          host: "ssh.example.com",
          credential: { id: credentialId },
          agentEnabled: true,
          ...secrets,
        }),
      ),
    ).rejects.toThrow("CLI exit");
    expect(displayed()).toContain("Invalid configuration input");
    expectNoSecrets();
  });
});
