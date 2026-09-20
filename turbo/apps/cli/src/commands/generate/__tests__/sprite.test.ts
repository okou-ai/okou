/**
 * Tests for okou generate sprite command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): none for the source-selection path
 * - Real (internal): prompt parsing, enum validation, and packet generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { DEFAULT_IMAGE_MODEL_ENV } from "@okouai/core/image-model-catalog";
import { generateCommand } from "../index";
import { spriteCommand } from "../sprite";

describe("okou generate sprite command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("should print a source selection packet with the resolved plan", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "sprite",
      "--prompt",
      "A green slime monster idle loop",
      "--asset-type",
      "creature",
      "--action",
      "idle",
      "--sheet",
      "3x3",
      "--name",
      "green-slime",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("# Okou generate sprite");
    expect(stdout).toContain("federated generation source-selection packet");
    expect(stdout).toContain("A green slime monster idle loop");
    expect(stdout).toContain("- Asset type: creature");
    expect(stdout).toContain("- Action: idle");
    expect(stdout).toContain("- Sheet / grid: 3x3");
    expect(stdout).toContain("Output name: green-slime");
    expect(stdout).toContain("0x0funky/agent-sprite-forge@main");
    expect(stdout).toContain(
      "Write the bundle under `./generated/sprites/green-slime/`.",
    );
  });

  it("should default unset flags to agent decides and recommend gpt-image-2", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "sprite",
      "--prompt",
      "A fireball projectile",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("- Asset type: agent decides");
    expect(stdout).toContain("- Sheet / grid: auto");
    expect(stdout).toContain("Use `gpt-image-2`");
    expect(stdout).toContain("--model gpt-image-2 --raw-prompt");
    expect(stdout).toContain("okou web upload-file -f <file>`");
    expect(stdout).toContain(
      "With privateArtifacts enabled, new artifacts default to only-me.",
    );
  });

  it.each(["only-me", "org", "public"])(
    "preserves %s visibility for delivered sprite files",
    async (visibility) => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "sprite",
        "--prompt",
        "A fireball projectile",
        "--visibility",
        visibility,
      ]);

      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      expect(stdout).toContain(
        `okou web upload-file -f <file> --visibility ${visibility}`,
      );
      expect(stdout).toContain(
        "Keep raw intermediate sheets at their default visibility.",
      );
      const rawGeneration = stdout.split("\n").find((line) => {
        return line.includes("okou generate image --provider built-in");
      });
      expect(rawGeneration).toContain("--raw-prompt");
      expect(rawGeneration).not.toContain("--visibility");
    },
  );

  it("should keep Sprite's implicit model inside a run with a default image model", async () => {
    vi.stubEnv(DEFAULT_IMAGE_MODEL_ENV, "flux-pro-1.1");

    await generateCommand.parseAsync([
      "node",
      "cli",
      "sprite",
      "--prompt",
      "A fireball projectile",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("Use `gpt-image-2`");
    expect(stdout).toContain("--model gpt-image-2 --raw-prompt");
    expect(stdout).not.toContain("Use the run default");
    expect(stdout).not.toContain("--model flux-pro-1.1 --raw-prompt");
  });

  it("should preserve Sprite's explicit model inside a gated run", async () => {
    vi.stubEnv(DEFAULT_IMAGE_MODEL_ENV, "flux-pro-1.1");

    await generateCommand.parseAsync([
      "node",
      "cli",
      "sprite",
      "--prompt",
      "A fireball projectile",
      "--model",
      "seedream4",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("Use `seedream4`");
    expect(stdout).toContain("--model seedream4 --raw-prompt");
    expect(stdout).not.toContain("Use the run default `flux-pro-1.1`");
  });

  it("should reject an unknown asset type", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "sprite",
        "--prompt",
        "A thing",
        "--asset-type",
        "definitely-not-an-asset-type",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("--asset-type must be one of");
  });

  it("should reject an invalid frame count", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "sprite",
        "--prompt",
        "A thing",
        "--frames",
        "999",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("--frames must be 'auto' or an integer");
  });

  it("should expose the sprite-specific flags in help", () => {
    let helpOutput = "";
    spriteCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    spriteCommand.outputHelp();

    expect(helpOutput).toContain("--prompt <text>");
    expect(helpOutput).toContain("--asset-type <type>");
    expect(helpOutput).toContain("--action <action>");
    expect(helpOutput).toContain("--view <view>");
    expect(helpOutput).toContain("--sheet <grid>");
    expect(helpOutput).toContain("--bundle <preset>");
    expect(helpOutput).toContain("--art-style <style>");
    expect(helpOutput).toContain("--visibility <visibility>");
  });
});
