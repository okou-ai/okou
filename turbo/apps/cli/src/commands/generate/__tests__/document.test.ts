import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_TEMPLATE_ITEMS } from "@okouai/core/document-template-items";
import { createGenerateCommand } from "../index";
import { server } from "../../../mocks/server";
import {
  catalogItem,
  stubConnectorCatalog,
} from "../../__tests__/helpers/connector-catalog";

describe("okou generate document", () => {
  let output: string;
  let errors: string;

  beforeEach(() => {
    output = "";
    errors = "";
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      output += values.join(" ") + "\n";
    });
    vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      errors += values.join(" ") + "\n";
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function run(...args: string[]): Promise<void> {
    await createGenerateCommand().parseAsync([
      "node",
      "okou",
      "document",
      ...args,
    ]);
  }

  it("discovers Default and the whole Document picker catalog without connector setup", async () => {
    await run();

    expect(output).toContain("Default:");
    expect(output).toContain("Author from a blank document");
    const ids = [...output.matchAll(/^ {2}(document-template:\S+) —/gm)].map(
      (match) => {
        return match[1];
      },
    );
    expect(ids).toEqual(
      DOCUMENT_TEMPLATE_ITEMS.map((item) => {
        return item.id;
      }),
    );
    expect(output).toContain("Monthly services (service-agreement)");
    expect(output).toContain("--template <id-or-default>");
    expect(output).toContain("--provider <connector>");
  });

  it("guides automatic choice between a compatible built-in and Default", async () => {
    await run("--prompt", "Create a Chinese sales follow-up guide as DOCX");

    expect(output).toContain("# Okou generate document");
    expect(output).toContain("Create a Chinese sales follow-up guide as DOCX");
    expect(output).toContain("Honor an attached or explicitly named template");
    expect(output).toContain("or Default when none fits");
    expect(output).toContain("Do not force an unrelated template");
    expect(output).toContain("Make this choice yourself");
    expect(output).toContain("document-template:monthly-services");
    expect(output).toContain(
      'okou generate document --template <id> --prompt "<same document request>"',
    );
    expect(output).toContain("source format does not override a DOCX, PDF");
    expect(output).toContain(
      "State whether Default or a built-in template was used",
    );
    expect(output).toContain("Files default to only-me");
  });

  it("honors explicit Default with built-in authoring and a requested PDF", async () => {
    await run(
      "--provider",
      "built-in",
      "--template",
      "default",
      "--prompt",
      "Create a sales handbook as PDF",
    );

    expect(output).toContain("## Default Document Authoring");
    expect(output).toContain("Default was explicitly selected");
    expect(output).toContain("do not select a built-in template");
    expect(output).toContain("office skill when applicable");
    expect(output).toContain("Create a sales handbook as PDF");
  });

  it.each([
    "monthly-services",
    "document-template:monthly-services",
    "document-monthly-services",
  ])(
    "resolves %s to the fixed Word original and fidelity guidance",
    async (id) => {
      await run("--template", id, "--prompt", "Draft monthly services as DOCX");

      expect(output).toContain("Selected document template: Monthly services");
      expect(output).toContain(
        "https://raw.githubusercontent.com/Oak-Harbor-Kits/Contract-Templates/4e49c669fa1e856d583723f0a60175533645b680/Monthly%20Subscription%20Contract%20Template.docx",
      );
      expect(output).toContain("- Layout previews:");
      expect(output).toContain("Read the complete upstream template");
      expect(output).toContain(
        "Preserve its content organization and visual design together",
      );
      expect(output).toContain("leave missing details as placeholders");
      expect(output).toContain("do not silently switch to Default");
    },
  );

  it("includes supporting source files at the same pinned revision", async () => {
    await run(
      "--template",
      "knowledge-handbook",
      "--prompt",
      "Create a training handbook",
    );

    const base =
      "https://raw.githubusercontent.com/fmarotta/kaobook/22225a174f1b667a50c0a80afb48c498e8126dc1";
    expect(output).toContain(`${base}/examples/documentation/main.tex`);
    expect(output).toContain("Supporting upstream files (same fixed commit)");
    expect(output).toContain(`${base}/kaobook.cls`);
    expect(output).toContain(`${base}/kao.sty`);
    expect(output).toContain(`${base}/examples/documentation/main.pdf`);
  });

  it("encodes non-ASCII paths in selected-template source links", async () => {
    await run(
      "--template",
      "design-services",
      "--prompt",
      "Draft a design services agreement",
    );

    expect(output).toContain(
      "https://raw.githubusercontent.com/studionaeo/design-services-standard-agreement/df71218eb1d5c5a59efb1ceb80de56a9935d6420/%E5%8D%8F%E8%AE%AE/%E8%AE%BE%E8%AE%A1%E6%9C%8D%E5%8A%A1%E6%A0%87%E5%87%86%E5%8D%8F%E8%AE%AE%E4%B9%A6.md",
    );
  });

  it.each([undefined, "default", "monthly-services"])(
    "preserves org delivery visibility with template %s",
    async (template) => {
      await run(
        "--prompt",
        "A service guide",
        "--visibility",
        "org",
        ...(template ? ["--template", template] : []),
      );

      expect(output).toContain(
        "okou web upload-file -f <file> --visibility org",
      );
      expect(output).toContain(
        "File-only delivery does not require HTML hosting",
      );
    },
  );

  it("keeps explicit connector guidance available", async () => {
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    server.use(
      stubConnectorCatalog([
        catalogItem({
          connectorSlug: "manus",
          label: "Manus",
          generation: ["document"],
        }),
      ]),
    );

    await run("--provider", "manus");

    expect(output).toContain(
      "Manus (manus) handles document generation through its own connector skill",
    );
    expect(output).toContain('Use the "manus" skill in this session');
    expect(output).toContain("okou connector status manus");
  });

  it("rejects conflicting connector and template selections instead of discarding one", async () => {
    await expect(
      run(
        "--provider",
        "manus",
        "--template",
        "default",
        "--prompt",
        "A guide",
      ),
    ).rejects.toThrow("process.exit called");

    expect(errors).toContain("cannot be combined with a connector --provider");
    expect(errors).toContain("Use one path");
  });

  it("provides valid choices for an unknown template", async () => {
    await expect(
      run("--template", "not-a-template", "--prompt", "A guide"),
    ).rejects.toThrow("process.exit called");

    expect(errors).toContain("Unknown document template: not-a-template");
    expect(errors).toContain("default — Author from a blank document");
    expect(errors).toContain("document-template:monthly-services");
    expect(errors).toContain("--template <id-or-default> --prompt");
  });

  it("exposes authoring flags and built-in choices in help", () => {
    const command = createGenerateCommand();
    const document = command.commands.find((subcommand) => {
      return subcommand.name() === "document";
    });
    document?.configureOutput({
      writeOut: (text) => {
        output += text;
      },
    });
    document?.outputHelp();

    expect(output).toContain("--prompt <text>");
    expect(output).toContain("--template <id>");
    expect(output).toContain("--provider <name>");
    expect(output).toContain("--visibility <visibility>");
    expect(output).toContain("not a completed document");
    expect(output).toContain("Built-in Document templates:");
    expect(output).toContain("document-template:monthly-services");
  });
});
