import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { artifactCommand } from "../index";
import {
  createArtifactFavoriteCommand,
  createArtifactFavoritesCommand,
  createArtifactUnfavoriteCommand,
} from "../favorites";

const API = "http://localhost:3000";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000001";
const UNAVAILABLE_ID = "00000000-0000-4000-8000-000000000002";
const REFERENCE = "/artifacts/abc123def4.pdf";
const favorites = {
  favorites: [
    {
      artifactId: ARTIFACT_ID,
      createdAt: "2026-11-27T08:00:00.000Z",
      artifact: {
        id: ARTIFACT_ID,
        kind: "file",
        title: "Shared report",
        thumbnail: null,
        category: "document",
        createdAt: "2026-11-26T08:00:00.000Z",
        updatedAt: "2026-11-26T08:00:00.000Z",
      },
    },
    {
      artifactId: UNAVAILABLE_ID,
      createdAt: "2026-11-26T08:00:00.000Z",
      artifact: null,
    },
  ],
  nextCursor: "next-page",
};

describe("artifact favorites", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("CLI exit");
  });

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", API);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    process.exitCode = 0;
  });

  it.each([
    { input: ARTIFACT_ID, body: { artifactId: ARTIFACT_ID } },
    { input: REFERENCE, body: { url: REFERENCE } },
    {
      input: "https://app.okou.ai/share/conversation-reference",
      body: { url: "https://app.okou.ai/share/conversation-reference" },
    },
  ])(
    "favorites $input through the authenticated API",
    async ({ input, body }) => {
      server.use(
        http.post(`${API}/api/artifact-favorites`, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          expect(await request.json()).toEqual(body);
          return HttpResponse.json({
            artifactId: ARTIFACT_ID,
            favorited: true,
          });
        }),
      );
      await createArtifactFavoriteCommand().parseAsync([input, "--json"], {
        from: "user",
      });
      expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual({
        artifactId: ARTIFACT_ID,
        favorited: true,
      });
    },
  );

  it("removes an unavailable favorite using its catalog ID", async () => {
    server.use(
      http.delete(`${API}/api/artifact-favorites/:artifactId`, ({ params }) => {
        expect(params.artifactId).toBe(UNAVAILABLE_ID);
        return HttpResponse.json({
          artifactId: UNAVAILABLE_ID,
          favorited: false,
        });
      }),
    );
    await createArtifactUnfavoriteCommand().parseAsync(
      [UNAVAILABLE_ID, "--json"],
      {
        from: "user",
      },
    );
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual({
      artifactId: UNAVAILABLE_ID,
      favorited: false,
    });
  });

  it("resolves a readable link before removing its catalog favorite", async () => {
    server.use(
      http.get(`${API}/api/artifact-favorites/resolve`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("url")).toBe(REFERENCE);
        return HttpResponse.json({ artifactId: ARTIFACT_ID, favorited: true });
      }),
      http.delete(`${API}/api/artifact-favorites/:artifactId`, ({ params }) => {
        expect(params.artifactId).toBe(ARTIFACT_ID);
        return HttpResponse.json({ artifactId: ARTIFACT_ID, favorited: false });
      }),
    );
    await createArtifactUnfavoriteCommand().parseAsync([REFERENCE], {
      from: "user",
    });
    expect(log.mock.calls.flat().join("\n")).toContain(
      `Not favorited: ${ARTIFACT_ID}`,
    );
  });

  it("preserves pagination and unavailable entries in JSON output", async () => {
    server.use(
      http.get(`${API}/api/artifact-favorites`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        expect(query.get("limit")).toBe("10");
        expect(query.get("cursor")).toBe("previous-page");
        expect(query.get("category")).toBe("document");
        expect(query.get("keyword")).toBe("report");
        return HttpResponse.json(favorites);
      }),
    );
    await createArtifactFavoritesCommand().parseAsync(
      [
        "--json",
        "--limit",
        "10",
        "--cursor",
        "previous-page",
        "--category",
        "document",
        "--keyword",
        "report",
      ],
      { from: "user" },
    );
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual(favorites);
  });

  it("shows unavailable entries and their removable IDs in readable output", async () => {
    server.use(
      http.get(`${API}/api/artifact-favorites`, () => {
        return HttpResponse.json(favorites);
      }),
    );
    await createArtifactFavoritesCommand().parseAsync([], { from: "user" });
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Shared report");
    expect(output).toContain(`Unavailable\n  Artifact ID: ${UNAVAILABLE_ID}`);
    expect(output).toContain("Next cursor: next-page");
  });

  it("routes favorites through the existing artifact parent command", async () => {
    server.use(
      http.get(`${API}/api/artifact-favorites`, () => {
        return HttpResponse.json(favorites);
      }),
    );
    await artifactCommand.parseAsync(["favorites", "--json"], { from: "user" });
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual(favorites);
  });

  it("provides an action for an empty collection", async () => {
    server.use(
      http.get(`${API}/api/artifact-favorites`, () => {
        return HttpResponse.json({ favorites: [], nextCursor: null });
      }),
    );
    await createArtifactFavoritesCommand().parseAsync([], { from: "user" });
    expect(log.mock.calls.flat().join("\n")).toContain(
      "okou artifact favorite <artifact>",
    );
  });

  it("reports the API feature gate without claiming a successful favorite", async () => {
    server.use(
      http.post(`${API}/api/artifact-favorites`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Enable artifactLibrary and star to use favorites",
            },
          },
          { status: 403 },
        );
      }),
    );
    await expect(
      createArtifactFavoriteCommand().parseAsync([ARTIFACT_ID], {
        from: "user",
      }),
    ).rejects.toThrow("CLI exit");
    expect(error.mock.calls.flat().join("\n")).toContain(
      "Enable artifactLibrary and star",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
