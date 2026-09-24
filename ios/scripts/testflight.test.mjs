import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { AppStoreConnect, prepare, distribute } from "./testflight.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const release = {
  appId: "app",
  groupId: "group",
  version: "0.1.1",
  buildNumber: "8",
};

async function apple(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const [header, claims, signature] = token.split(".");
      assert.equal(JSON.parse(Buffer.from(header, "base64url")).kid, "key-id");
      assert.equal(
        JSON.parse(Buffer.from(claims, "base64url")).iss,
        "issuer-id",
      );
      assert.ok(
        verify(
          "sha256",
          Buffer.from(`${header}.${claims}`),
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(signature, "base64url"),
        ),
      );
      let body = "";
      for await (const chunk of request) body += chunk;
      const url = new URL(request.url, "http://localhost");
      const call = {
        url,
        method: request.method,
        body: body ? JSON.parse(body) : undefined,
      };
      requests.push(call);
      const result = await handler(call, requests);
      response.writeHead(result.status ?? 200, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(result.body));
    } catch (error) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const client = new AppStoreConnect({
    keyId: "key-id",
    issuerId: "issuer-id",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    apiOrigin: `http://127.0.0.1:${server.address().port}`,
  });
  return { client, requests };
}

function setup({ url }) {
  if (url.pathname === "/v1/apps") return { body: { data: [{ id: "app" }] } };
  if (url.pathname === "/v1/apps/app/betaGroups")
    return {
      body: {
        data: [
          {
            id: "group",
            attributes: { name: "Internal", isInternalGroup: true },
          },
        ],
      },
    };
  if (url.pathname === "/v1/betaGroups/group/betaTesters")
    return { body: { data: [{ id: "tester" }] } };
  if (url.pathname === "/v1/builds")
    return {
      body: {
        data: [{ attributes: { version: "7" } }],
        links: { next: "/page2" },
      },
    };
  if (url.pathname === "/page2")
    return { body: { data: [{ attributes: { version: "2" } }] } };
  throw new Error(`Unexpected request ${url}`);
}

function buildResponse(state = "IN_BETA_TESTING", processing = "VALID") {
  return {
    body: {
      data: [
        {
          id: "build",
          attributes: { processingState: processing, expired: false },
          relationships: { buildBetaDetail: { data: { id: "detail" } } },
        },
      ],
      included: [
        {
          type: "buildBetaDetails",
          id: "detail",
          attributes: { internalBuildState: state },
        },
      ],
    },
  };
}

test("resolves the production bundle, internal group and next build across pages", async (t) => {
  const { client, requests } = await apple(t, setup);
  assert.deepEqual(await prepare(client, "0.1.1", "Internal"), release);
  assert.equal(
    requests[0].url.searchParams.get("filter[bundleId]"),
    "ai.okou.ios",
  );
  assert.ok(requests.every((r) => r.method === "GET"));
});

for (const condition of ["external", "missing", "empty"]) {
  test(`preflight refuses ${condition} internal group`, async (t) => {
    const { client, requests } = await apple(t, (call) => {
      if (call.url.pathname.endsWith("/betaGroups") && condition !== "empty") {
        return {
          body: {
            data:
              condition === "missing"
                ? []
                : [
                    {
                      id: "group",
                      attributes: { name: "Internal", isInternalGroup: false },
                    },
                  ],
          },
        };
      }
      if (condition === "empty" && call.url.pathname.endsWith("/betaTesters"))
        return { body: { data: [] } };
      return setup(call);
    });
    await assert.rejects(
      prepare(client, "0.1.1", "Internal"),
      /internal TestFlight group|no testers/,
    );
    assert.ok(requests.every((r) => r.method === "GET"));
  });
}

test("waits for processing and persisted internal group availability", async (t) => {
  let reads = 0;
  let assigned = false;
  const { client, requests } = await apple(t, ({ url, method, body }) => {
    if (url.pathname === "/v1/builds") {
      assert.equal(url.searchParams.get("filter[app]"), "app");
      assert.equal(url.searchParams.get("filter[version]"), "8");
      assert.equal(
        url.searchParams.get("filter[preReleaseVersion.version]"),
        "0.1.1",
      );
      assert.equal(
        url.searchParams.get("filter[preReleaseVersion.platform]"),
        "IOS",
      );
      reads++;
      if (reads === 1) return { body: { data: [] } };
      if (reads === 2) return buildResponse("PROCESSING", "PROCESSING");
      return buildResponse(
        assigned ? "IN_BETA_TESTING" : "READY_FOR_BETA_TESTING",
      );
    }
    if (url.pathname === "/v1/betaGroups/group")
      return { body: { data: { attributes: { isInternalGroup: true } } } };
    if (url.pathname === "/v1/betaGroups/group/relationships/builds") {
      if (method === "POST") {
        assert.deepEqual(body, { data: [{ type: "builds", id: "build" }] });
        assigned = true;
        return { status: 204 };
      }
      return {
        body: { data: assigned ? [{ id: "build", type: "builds" }] : [] },
      };
    }
    throw new Error(`Unexpected request ${url}`);
  });
  assert.equal(
    await distribute(client, release, { pollMs: 1, timeoutMs: 2000 }),
    "build",
  );
  assert.ok(assigned);
  assert.equal(requests.filter((r) => r.method === "POST").length, 1);
});

test("already distributed build is verified without another mutation", async (t) => {
  const { client, requests } = await apple(t, ({ url }) => {
    if (url.pathname === "/v1/builds") return buildResponse();
    if (url.pathname === "/v1/betaGroups/group")
      return { body: { data: { attributes: { isInternalGroup: true } } } };
    return { body: { data: [{ id: "build", type: "builds" }] } };
  });
  assert.equal(await distribute(client, release), "build");
  assert.ok(requests.every((r) => r.method === "GET"));
});

for (const [label, response, error] of [
  ["invalid build", buildResponse("PROCESSING", "INVALID"), /rejected/],
  [
    "processing exception",
    buildResponse("PROCESSING_EXCEPTION"),
    /requires action/,
  ],
  [
    "missing compliance",
    buildResponse("MISSING_EXPORT_COMPLIANCE"),
    /requires action/,
  ],
  ["denied API access", { status: 403, body: {} }, /HTTP 403/],
  [
    "processing timeout",
    buildResponse("PROCESSING", "PROCESSING"),
    /Timed out/,
  ],
]) {
  test(`does not report success for ${label}`, async (t) => {
    const { client, requests } = await apple(t, () => response);
    await assert.rejects(distribute(client, release, { timeoutMs: 0 }), error);
    assert.ok(requests.every((r) => r.method === "GET"));
  });
}

test("distribution rechecks group and never assigns a build to an external group", async (t) => {
  const { client, requests } = await apple(t, ({ url }) =>
    url.pathname === "/v1/builds"
      ? buildResponse()
      : { body: { data: { attributes: { isInternalGroup: false } } } },
  );
  await assert.rejects(distribute(client, release), /Refusing external/);
  assert.ok(requests.every((r) => r.method === "GET"));
});

test("pagination cannot forward Apple credentials to another origin", async (t) => {
  const { client } = await apple(t, () => ({
    body: { data: [], links: { next: "https://example.invalid/steal" } },
  }));
  await assert.rejects(client.list("/v1/apps"), /pagination origin/);
});

test("automatic internal group waits for Apple's assignment without writing", async (t) => {
  let reads = 0;
  const { client, requests } = await apple(t, ({ url }) => {
    if (url.pathname === "/v1/builds") return buildResponse();
    if (url.pathname === "/v1/betaGroups/group")
      return {
        body: {
          data: {
            attributes: { isInternalGroup: true, hasAccessToAllBuilds: true },
          },
        },
      };
    reads++;
    return {
      body: { data: reads > 1 ? [{ id: "build", type: "builds" }] : [] },
    };
  });
  assert.equal(
    await distribute(client, release, { pollMs: 1, timeoutMs: 2000 }),
    "build",
  );
  assert.ok(requests.every((r) => r.method === "GET"));
});
