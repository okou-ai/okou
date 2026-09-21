import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { buildSlackSystemPrompt } from "../../../lib/slack-webhook-context";
import { buildAgentToolsPrompt } from "../agent-tools-prompt.service";
import {
  hasIntegrationNote,
  resolveIntegrationNotePrompt,
} from "../integration-note-prompt.service";

const CONVERSATIONAL_SOURCES = [
  "web",
  "agent",
  "slack",
  "feishu",
  "lark",
  "teams",
  "github",
  "telegram",
  "agentphone",
] as const satisfies readonly TriggerSource[];

const HEADLESS_SOURCES = [
  "email",
  "test",
  "webhook",
  "automation-schedule",
  "automation-event",
  "goal",
] as const satisfies readonly TriggerSource[];

function noteFor(
  triggerSource: TriggerSource,
  privateArtifactsEnabled: boolean,
): string {
  return resolveIntegrationNotePrompt({
    triggerSource,
    featureSwitchContext: {
      overrides: {
        [FeatureSwitchKey.PrivateArtifacts]: privateArtifactsEnabled,
        [FeatureSwitchKey.LarkIntegration]: false,
      },
    },
  });
}

function toolsPromptFor(triggerSource: TriggerSource): string {
  return buildAgentToolsPrompt({
    privateArtifactsEnabled: false,
    triggerSource,
    cloudBrowserEnabled: false,
    runUsageEnabled: false,
    bankingEnabled: false,
    vncEnabled: false,
    larkEnabled: false,
    deliveryFormatGuidanceEnabled: true,
    presentationConvertEnabled: false,
  });
}

describe("integration note prompt", () => {
  it("renders one bulleted section per conversational surface", () => {
    for (const triggerSource of CONVERSATIONAL_SOURCES) {
      const note = noteFor(triggerSource, false);
      const [heading, blank, ...lines] = note.split("\n");
      expect(heading).toBe("# Integration Note");
      expect(blank).toBe("");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.startsWith("- ")).toBeTruthy();
      }
    }
  });

  /**
   * A run with no conversational surface never renders `# Current Integration`,
   * so it has nowhere to carry a note and keeps its fallback delivery guidance
   * in `# Agent Tools` instead.
   */
  it("leaves headless trigger sources without a note and keeps their fallback line", () => {
    const fallback =
      "- Use integration-specific messaging or file commands only when the task names an explicit delivery target or the current surface provides one.";
    for (const triggerSource of HEADLESS_SOURCES) {
      expect(hasIntegrationNote(triggerSource)).toBeFalsy();
      expect(noteFor(triggerSource, false)).toBe("");
      expect(toolsPromptFor(triggerSource)).toContain(fallback);
    }
    for (const triggerSource of CONVERSATIONAL_SOURCES) {
      expect(hasIntegrationNote(triggerSource)).toBeTruthy();
      expect(toolsPromptFor(triggerSource)).not.toContain(fallback);
    }
  });

  it("moves surface delivery rules out of the agent tools prompt", () => {
    expect(toolsPromptFor("slack")).not.toContain("okou slack download-file");
    expect(noteFor("slack", false)).toContain("okou slack download-file");
  });

  it("promises only the final reply, not progress during the run", () => {
    const note = noteFor("slack", false);
    expect(note).toContain("only your final reply is delivered");
    expect(note).not.toContain("normal replies are automatically sent");
  });

  /**
   * A private artifact address is owner-scoped, so a link in the final reply
   * leaves an external recipient with nothing to open. Web chat resolves the
   * address itself and needs no upload.
   */
  it("adds the private artifact upload rule to external surfaces only when the switch is on", () => {
    const uploadRule = "Private artifacts in the final reply";
    for (const triggerSource of ["slack", "feishu", "teams"] as const) {
      expect(noteFor(triggerSource, false)).not.toContain(uploadRule);
      expect(noteFor(triggerSource, true)).toContain(uploadRule);
    }
    expect(noteFor("web", true)).not.toContain(uploadRule);
  });

  it("never asks to upload a site or page", () => {
    expect(noteFor("slack", true)).toContain(
      "a hosted website or HTML page never qualifies",
    );
  });

  it("places the note between the current integration block and the context", () => {
    const prompt = buildSlackSystemPrompt({
      botUserId: "U1",
      channelId: "C1",
      channelType: "channel",
      threadTs: "1.2",
      integrationNote: noteFor("slack", true),
      executionContext: "# Recent Channel Messages\n\nhello",
    });
    expect(prompt).toContain(
      "Thread ID: 1.2\n\n# Integration Note\n\n- Slack messaging and files:",
    );
    expect(prompt.indexOf("# Integration Note")).toBeLessThan(
      prompt.indexOf("# Recent Channel Messages"),
    );
  });

  it("omits the note section when a surface prompt has none", () => {
    const prompt = buildSlackSystemPrompt({
      botUserId: "U1",
      channelId: "C1",
      channelType: "dm",
      threadTs: "1.2",
      integrationNote: "",
      executionContext: "",
    });
    expect(prompt).not.toContain("# Integration Note");
    expect(prompt.endsWith("Thread ID: 1.2")).toBeTruthy();
  });
});
