import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import type { HostedSiteVisibility } from "@okouai/api-contracts/contracts/hosted-site-access";
import { server } from "../../../mocks/server";
import { createHostCommand } from "../index";

const siteId = "00000000-0000-4000-8000-000000000001";
const deploymentId = "00000000-0000-4000-8000-000000000002";
const base = "http://localhost:3000/api";
const siteUrl = "https://demo-site.okou.app";

describe("hosted website email visibility", () => {
  let directory: string;
  let events: string[];
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    directory = mkdtempSync(join(tmpdir(), "host-email-"));
    writeFileSync(join(directory, "index.html"), "<main>Private report</main>");
    events = [];
    mockAvailability();
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    logs.mockClear();
    errors.mockClear();
  });

  function mockAvailability(enabled = true) {
    server.use(
      http.get(`${base}/feature-switches`, ({ request }) => {
        events.push("availability");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          switches: {},
          effectiveSwitches: { artifactUserSharing: enabled },
        });
      }),
    );
  }

  function mockPublication(acknowledgement: HostedSiteVisibility = "private") {
    server.use(
      http.post(`${base}/host/deployments/prepare`, async ({ request }) => {
        events.push("prepare");
        const body = hostContract.prepare.body.parse(await request.json());
        expect(body.visibility).toBe("private");
        return HttpResponse.json({
          siteId,
          deploymentId,
          title: "Private report",
          publicSlug: "demo-site",
          url: siteUrl,
          visibility: acknowledgement,
          uploads: body.files.map((file) => {
            return {
              path: file.path,
              uploadUrl: `https://uploads.example.com${file.path}`,
            };
          }),
        });
      }),
      http.put("https://uploads.example.com/*", () => {
        events.push("upload");
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${base}/host/deployments/${deploymentId}/complete`, () => {
        events.push("complete");
        return HttpResponse.json({
          siteId,
          deploymentId,
          publicSlug: "demo-site",
          url: siteUrl,
          status: "ready",
        });
      }),
    );
  }

  function mockSettings({
    initial = "public",
    conflict = false,
    acknowledge = true,
    failEmail,
  }: {
    initial?: HostedSiteVisibility;
    conflict?: boolean;
    acknowledge?: boolean;
    failEmail?: string;
  } = {}) {
    let status = {
      artifactId: siteId,
      kind: "hosted-site" as const,
      visibility: initial,
      ownerUrl: siteUrl,
      shareUrl: null,
      shortUrl: null,
      organization: { id: "org_test", name: "Test organization" },
    };
    const shares: { userId: string; email: string }[] = [];
    server.use(
      http.get(`${base}/host/aliases/demo-site`, () => {
        events.push("resolve");
        return HttpResponse.json({
          pointer: {
            version: 1,
            publicBrand: "okou",
            publicSlug: "demo-site",
            siteId,
            deploymentId,
            prefix: `sites/brands/okou/publications/${deploymentId}`,
            manifestKey: `sites/brands/okou/publications/${deploymentId}/manifest.json`,
            spaFallback: false,
            updatedAt: "2026-11-23T00:00:00Z",
          },
        });
      }),
      http.get(`${base}/artifacts/${siteId}/visibility`, () => {
        events.push("read-visibility");
        return HttpResponse.json(status);
      }),
      http.patch(
        `${base}/artifacts/${siteId}/visibility`,
        async ({ request }) => {
          const body = artifactAccessContract.updateVisibility.body.parse(
            await request.json(),
          );
          events.push(`visibility:${body.visibility}`);
          if (conflict) {
            return HttpResponse.json(
              {
                error: {
                  code: "CONFLICT",
                  message: "Visibility changed; reload",
                },
              },
              { status: 409 },
            );
          }
          status = {
            ...status,
            visibility: acknowledge ? body.visibility : "public",
          };
          return HttpResponse.json(status);
        },
      ),
      http.post(`${base}/artifacts/${siteId}/shares`, async ({ request }) => {
        const body = artifactAccessContract.addShare.body.parse(
          await request.json(),
        );
        if (!("email" in body)) {
          throw new Error("Expected CLI to send email payload");
        }
        const { email } = body;
        events.push(`share:${email}`);
        expect(status.visibility).toBe("private");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        if (email === failEmail) {
          return HttpResponse.json(
            { error: { code: "RATE_LIMITED", message: "Try again later" } },
            { status: 429 },
          );
        }
        const share = { userId: `user_${randomUUID().slice(0, 8)}`, email };
        shares.push(share);
        return HttpResponse.json({ share });
      }),
    );
    return shares;
  }

  function publishArgs(visibility = "email") {
    return [
      "node",
      "okou",
      directory,
      "--site",
      "demo-site",
      "--title",
      "Private report",
      "--json",
      "--visibility",
      visibility,
    ];
  }

  it("exposes email visibility and the separate settings command in help", async () => {
    let help = "";
    const command = createHostCommand()
      .exitOverride()
      .configureOutput({
        writeOut: (text) => {
          help += text;
        },
      });
    await expect(
      command.parseAsync(["node", "okou", "--help"]),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
    expect(help).toContain("--email");
    expect(help).toContain("email");
    expect(help).toContain("visibility");
  });

  it("publishes privately before inviting normalized, deduplicated recipients", async () => {
    mockPublication();
    const shares = mockSettings();
    await createHostCommand().parseAsync([
      ...publishArgs(),
      "--email",
      " ALICE@EXAMPLE.COM ",
      "--email",
      "alice@example.com",
      "--email",
      "bob@example.com",
    ]);
    const output = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    expect(output).toMatchObject({ url: siteUrl, visibility: "email", shares });
    expect(
      shares.map((share) => {
        return share.email;
      }),
    ).toStrictEqual(["alice@example.com", "bob@example.com"]);
    expect(events.indexOf("complete")).toBeGreaterThan(
      events.indexOf("upload"),
    );
    expect(events.indexOf("visibility:private")).toBeGreaterThan(
      events.indexOf("complete"),
    );
    expect(events.indexOf("share:alice@example.com")).toBeGreaterThan(
      events.indexOf("visibility:private"),
    );
  });

  it.each([
    { visibility: "email", emails: [], message: "at least one --email" },
    {
      visibility: "email",
      emails: ["Nickname"],
      message: "complete email address",
    },
    {
      visibility: "public",
      emails: ["person@example.com"],
      message: "--email requires email visibility",
    },
  ])(
    "rejects invalid recipients before publication: $message",
    async ({ visibility, emails, message }) => {
      await expect(
        createHostCommand().parseAsync([
          ...publishArgs(visibility),
          ...emails.flatMap((email) => {
            return ["--email", email];
          }),
        ]),
      ).rejects.toThrow("process.exit called");
      expect(errors.mock.calls.flat().join("\n")).toContain(message);
      expect(events).toStrictEqual([]);
      expect(logs.mock.calls).toHaveLength(0);
    },
  );

  it("checks the staff switch before publishing any site or files", async () => {
    mockAvailability(false);
    await expect(
      createHostCommand().parseAsync([
        ...publishArgs(),
        "--email",
        "person@example.com",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(events).toStrictEqual(["availability"]);
    expect(errors.mock.calls.flat().join("\n")).toContain("not enabled");
    expect(logs.mock.calls).toHaveLength(0);
  });

  it("does not upload or invite when email visibility is acknowledged as public", async () => {
    mockPublication("public");
    await expect(
      createHostCommand().parseAsync([
        ...publishArgs(),
        "--email",
        "person@example.com",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(events).toStrictEqual(["availability", "prepare"]);
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "did not acknowledge",
    );
  });

  it("reads an existing site's general audience without publishing", async () => {
    mockSettings({ initial: "organization" });
    await createHostCommand().parseAsync([
      "node",
      "okou",
      "--json",
      "visibility",
      "demo-site",
    ]);
    expect(JSON.parse(logs.mock.calls.at(-1)![0] as string)).toMatchObject({
      publicSlug: "demo-site",
      siteId,
      visibility: "org",
    });
    expect(events).toStrictEqual(["resolve", "read-visibility"]);
  });

  it("sets email visibility on an existing site and combines parent and command recipients", async () => {
    const shares = mockSettings();
    await createHostCommand().parseAsync([
      "node",
      "okou",
      "--json",
      "--email",
      "a@example.com",
      "visibility",
      "demo-site",
      "email",
      "--email",
      "b@example.com",
    ]);
    expect(JSON.parse(logs.mock.calls.at(-1)![0] as string)).toMatchObject({
      publicSlug: "demo-site",
      siteId,
      visibility: "email",
      shares,
    });
    expect(
      shares.map((share) => {
        return share.email;
      }),
    ).toStrictEqual(["a@example.com", "b@example.com"]);
    expect(events).not.toContain("prepare");
  });

  it("changes the general audience without requiring email sharing to be enabled", async () => {
    mockAvailability(false);
    mockSettings({ initial: "private" });
    await createHostCommand().parseAsync([
      "node",
      "okou",
      "visibility",
      "demo-site",
      "org",
      "--json",
    ]);
    expect(JSON.parse(logs.mock.calls.at(-1)![0] as string)).toMatchObject({
      siteId,
      publicSlug: "demo-site",
      visibility: "org",
    });
    expect(events).toStrictEqual([
      "resolve",
      "read-visibility",
      "visibility:organization",
    ]);
  });

  it.each([
    {
      conflict: true,
      acknowledge: true,
      message: "Visibility changed; reload",
    },
    {
      conflict: false,
      acknowledge: false,
      message: "did not confirm the requested website visibility",
    },
  ])(
    "never invites after a failed visibility change: $message",
    async (failure) => {
      mockSettings(failure);
      await expect(
        createHostCommand().parseAsync([
          "node",
          "okou",
          "visibility",
          "demo-site",
          "email",
          "--email",
          "person@example.com",
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(events).toStrictEqual([
        "availability",
        "resolve",
        "read-visibility",
        "visibility:private",
      ]);
      expect(errors.mock.calls.flat().join("\n")).toContain(failure.message);
      expect(logs.mock.calls).toHaveLength(0);
    },
  );

  it("reports confirmed invitations and a quoted recovery command without republishing or retrying", async () => {
    mockPublication();
    const failedEmail = "o'neal@example.com";
    const shares = mockSettings({ failEmail: failedEmail });
    await expect(
      createHostCommand().parseAsync([
        ...publishArgs(),
        "--email",
        "a@example.com",
        "--email",
        failedEmail,
        "--email",
        "later@example.com",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(
      shares.map((share) => {
        return share.email;
      }),
    ).toStrictEqual(["a@example.com"]);
    expect(
      events.filter((event) => {
        return event.startsWith("share:");
      }),
    ).toStrictEqual(["share:a@example.com", `share:${failedEmail}`]);
    expect(
      events.filter((event) => {
        return event === "prepare";
      }),
    ).toHaveLength(1);
    const error = errors.mock.calls.flat().join("\n");
    expect(error).toContain('Confirmed invitations: ["a@example.com"]');
    expect(error).toContain(siteUrl);
    expect(error).toContain("Try again later");
    expect(error).toContain(
      "okou host visibility demo-site email --email 'o'\"'\"'neal@example.com' --email 'later@example.com'",
    );
    expect(error).toContain("Do not republish");
    expect(logs.mock.calls).toHaveLength(0);
  });
});
