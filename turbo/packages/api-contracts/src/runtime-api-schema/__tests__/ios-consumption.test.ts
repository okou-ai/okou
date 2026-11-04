import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runRuntimeApiSchemaCli } from "../command";

let root: string;
let output: string[];
let errors: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ios-api-consumption-"));
  output = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    output.push(line);
  });
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    errors.push(line);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function source(contents: string, file = "ios/Okou/Example.swift") {
  const path = join(root, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function lint() {
  return runRuntimeApiSchemaCli(["lint-ios-consumption", "--root", root]);
}

describe("iOS API consumption CLI", () => {
  it("accepts the hosted-site preview and explicitly registered write methods", async () => {
    await source(String.raw`
      let preview: Preview = try await client.request(
        "/api/host/sites/\(slug)/preview", query: query)
      try await client.data("/api/chat-threads/\(id)", method: "PATCH", body: body)
      try await client.data("/api/chat-threads/\(id)/connector-selections", method: "DELETE", body: body)
    `);
    expect(await lint()).toBe(0);
    expect(output.join("\n")).toContain("inventory covers all Swift API calls");
  });

  it("rejects a newly consumed endpoint with an actionable source location", async () => {
    await source(String.raw`
      try await api.request("/api/host/sites/\(id)/new-operation")
    `);
    expect(await lint()).toBe(1);
    expect(errors.join("\n")).toContain("file=ios/Okou/Example.swift,line=2");
    expect(errors.join("\n")).toContain(
      "GET /api/host/sites/{parameter}/new-operation",
    );
    expect(errors.join("\n")).toContain("ios-routes.ts");
  });

  it("checks the HTTP method rather than accepting a registered path alone", async () => {
    await source(String.raw`
      try await client.request("/api/host/sites/\(id)/preview", method: "DELETE")
    `);
    expect(await lint()).toBe(1);
    expect(errors.join("\n")).toContain(
      "DELETE /api/host/sites/{parameter}/preview",
    );
  });

  it("rejects endpoint selectors hidden in interpolated path segments", async () => {
    await source(String.raw`
      try await client.data("/api/chat-threads/\(id)/\(action)", method: "POST")
    `);
    expect(await lint()).toBe(1);
    expect(errors.join("\n")).toContain(
      "/api/chat-threads/{parameter}/{parameter}",
    );
  });

  it("rejects computed paths and methods instead of silently skipping their calls", async () => {
    await source(String.raw`
      try await client.request(path)
      try await client.data("/api/chat-threads/\(id)", method: selectedMethod)
    `);
    expect(await lint()).toBe(1);
    expect(errors.join("\n")).toContain("explicit API path literal");
    expect(errors.join("\n")).toContain("explicit HTTP method literal");
  });

  it("rejects escaped separators rather than hiding an unregistered endpoint in a parameter", async () => {
    await source(
      String.raw`try await client.request("/api/agents/\u{2f}unregistered")`,
    );
    expect(await lint()).toBe(1);
    expect(errors.join("\n")).toContain("unescaped API path text");
  });

  it("does not treat comments, strings, or Foundation calls as API consumers", async () => {
    await source(String.raw`
      // client.request("/api/not-a-call")
      /* outer /* client.request("/api/not-a-call") */ comment */
      let note = "client.request(\"/api/not-a-call\")"
      let bytes = try JSONSerialization.data(withJSONObject: object)
      let result = try await URLSession.shared.data(from: signedURL)
      if path == "/api/recognized-url" { recognize() }
      try await client.request("/api/agents")
    `);
    expect(await lint()).toBe(0);
  });

  it("checks raw strings and nested interpolation expressions", async () => {
    await source(String.raw`
      try await client.request(#"/api/agents/\#(identifier("value"))"#)
      try await request("/api/agents/\(identifier("value"))")
    `);
    expect(await lint()).toBe(0);
  });

  it("keeps transport forwarding distinct from hard-coded consumers in the same file", async () => {
    const file = "ios/Packages/ChatData/Sources/ChatData/APIClient.swift";
    await source(
      String.raw`
      func data(_ path: String, method: String) {}
      let response = try await data(path, method: method)
      try await request("/api/unregistered")
    `,
      file,
    );
    expect(await lint()).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("GET /api/unregistered");
  });

  it("includes notification-extension consumers while excluding test fixtures", async () => {
    await source(
      'try await client.request("/api/unregistered")',
      "ios/Push/Extension.swift",
    );
    await source(
      'client.request("/api/fixture")',
      "ios/Packages/ChatData/Tests/Test.swift",
    );
    expect(await lint()).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("file=ios/Push/Extension.swift");
  });
});
