import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import { HttpResponse, http } from "msw";

import { server } from "../../../mocks/server";
import { mapsCommand } from "../index";

function groundedResponse(model = "gemini-3.5-flash-lite") {
  const answer = "Café Central is open nearby.";
  return {
    query: "best café near me",
    location: { latitude: 48.21, longitude: 16.37 },
    languageCode: "de_AT",
    provider: "google-maps-grounding" as const,
    model,
    billingCategory: "provider_cost_usd_micros" as const,
    billingQuantity: 14_155,
    providerCostUsd: 0.014155,
    creditsCharged: 18,
    answer,
    sources: [
      {
        title: "Café Central",
        uri: "https://maps.google.com/?cid=123",
      },
    ],
    citations: [
      {
        startByte: 0,
        endByte: Buffer.byteLength(answer),
        text: answer,
        sourceIndices: [0],
      },
    ],
    attribution: "Google Maps" as const,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

describe("okou maps command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("posts one conversational search with explicit location and language", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/maps/search",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(groundedResponse());
        },
      ),
    );

    await mapsCommand.parseAsync([
      "node",
      "cli",
      "search",
      "best café near me",
      "--lat",
      "48.21",
      "--lng",
      "16.37",
      "--language",
      "de-AT",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      query: "best café near me",
      location: { latitude: 48.21, longitude: 16.37 },
      languageCode: "de_AT",
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify(groundedResponse()),
    );
  });

  it("keeps the grounded answer immediately adjacent to Google Maps sources", async () => {
    server.use(
      http.post("http://localhost:3000/api/maps/search", () => {
        return HttpResponse.json(groundedResponse());
      }),
    );

    await mapsCommand.parseAsync([
      "node",
      "cli",
      "search",
      "best café near me",
    ]);

    const lines = mockConsoleLog.mock.calls.map(([line]) => {
      return String(line);
    });
    const answerIndex = lines.indexOf(groundedResponse().answer);
    expect(answerIndex).toBeGreaterThanOrEqual(0);
    expect(lines[answerIndex + 1]).toBe("Google Maps sources:");
    expect(lines[answerIndex + 2]).toBe("1. Café Central");
    expect(lines[answerIndex + 3]).toBe("   https://maps.google.com/?cid=123");
    expect(lines.join("\n")).toContain("Provider cost: $0.014155");
    expect(lines.join("\n")).toContain("Credits charged: 18");
  });

  it.each(["gemini-2.5-flash", "gemini-3.5-flash-lite"])(
    "renders the server's %s model during API and CLI version overlap",
    async (model) => {
      server.use(
        http.post("http://localhost:3000/api/maps/search", () => {
          return HttpResponse.json(groundedResponse(model));
        }),
      );

      await mapsCommand.parseAsync([
        "node",
        "cli",
        "search",
        "coffee in Vienna",
      ]);

      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(model);
    },
  );

  it.each([
    { mode: "human", options: [] },
    { mode: "--json", options: ["--json"] },
  ])(
    "shows the oversized response cause and recovery guidance in $mode mode",
    async ({ options }) => {
      const message =
        "Google Maps grounding response exceeded Okou's response size limit. Narrow the search area, request fewer places, or split the query before trying again.";
      server.use(
        http.post("http://localhost:3000/api/maps/search", () => {
          return HttpResponse.json(
            { error: { code: "MAPS_RESPONSE_TOO_LARGE", message } },
            { status: 502 },
          );
        }),
      );

      await expect(
        mapsCommand.parseAsync([
          "node",
          "cli",
          "search",
          "coffee near Union Square",
          ...options,
        ]),
      ).rejects.toThrow("process.exit called");

      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        `✗ 502: ${message}`,
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    },
  );

  it("requires latitude and longitude together", async () => {
    await expect(
      mapsCommand.parseAsync([
        "node",
        "cli",
        "search",
        "coffee near me",
        "--lat",
        "40.7",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "--lat and --lng must be provided together",
    );
  });

  it("exposes only the search subcommand", () => {
    expect(
      mapsCommand.commands.map((command) => {
        return command.name();
      }),
    ).toStrictEqual(["search"]);
    expect(mapsCommand.helpInformation()).toContain("search [options] <query>");
  });

  it("shows auth guidance when no token is available", async () => {
    vi.stubEnv("OKOU_TOKEN", undefined);

    await expect(
      mapsCommand.parseAsync([
        "node",
        "cli",
        "search",
        "coffee near Union Square",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("✗ Not authenticated");
    expect(errors).toContain("Set OKOU_TOKEN to a valid run token");
  });
});
