import { describe, expect, it } from "vitest";
import { googleWorkspaceConversion } from "../google-workspace-conversion";

describe("Google Workspace import eligibility", () => {
  it("recognizes document and spreadsheet extensions irrespective of case and URL suffixes", () => {
    expect(
      googleWorkspaceConversion("/artifacts/Report.DOCX?download=1")?.target,
    ).toBe("document");
    expect(googleWorkspaceConversion("Data.ODS#sheet=2")?.target).toBe(
      "spreadsheet",
    );
    expect(googleWorkspaceConversion("Notes.Markdown")?.sourceMimeType).toBe(
      "text/markdown",
    );
    expect(googleWorkspaceConversion("table.tsv")?.sourceMimeType).toBe(
      "text/tab-separated-values",
    );
  });

  it("does not mistake source code, PDF, macro workbooks or prototype properties for importable files", () => {
    for (const name of [
      "script.py",
      "script.js",
      "report.pdf",
      "table.xlsm",
      "site.html",
      "document",
      "docx",
      "x.constructor",
      "x.__proto__",
    ]) {
      expect(googleWorkspaceConversion(name)).toBeNull();
    }
  });
});
