import { createArtifactGenerateCommand } from "../shared/artifact-generate";

export const reportCommand = createArtifactGenerateCommand({
  target: "report",
  description: "Generate an HTML report from a prompt",
  examples: `  Generate report:      okou generate report --prompt "A Q2 usage report for the API team"
  Custom site slug:      okou generate report --site-slug api-usage-q2 --prompt "A Q2 usage report"
  Show choices:          okou generate report`,
  artifactRules: [
    "Produce an analytical report, not a marketing page.",
    "Use concrete metrics, tables, chart-like visuals, and a clear findings section.",
    "Keep source assumptions visible when the prompt does not provide real data.",
    "Verify the report is readable at desktop and mobile widths.",
  ],
});

export const docsDesignCommand = createArtifactGenerateCommand({
  target: "docs-design",
  description: "Generate a documentation design from a prompt",
  examples: `  Generate docs design: okou generate docs-design --prompt "Docs for adding artifact targets"
  Custom site slug:      okou generate docs-design --site-slug artifact-target-docs --prompt "Artifact target docs"
  Show choices:          okou generate docs-design`,
  artifactRules: [
    "Produce a documentation design mockup, not a production documentation system.",
    "Include navigation, article structure, code or command examples when relevant, and clear section anchors as static design content.",
    "Use restrained documentation styling optimized for long-form reading.",
    "Verify the page works at mobile and desktop widths.",
  ],
});

export const posterCommand = createArtifactGenerateCommand({
  target: "poster",
  description: "Generate an HTML poster from a prompt",
  examples: `  Generate poster:      okou generate poster --prompt "A launch poster for artifact targets"
  Custom site slug:      okou generate poster --site-slug artifact-poster --prompt "A launch poster"
  Show choices:          okou generate poster`,
  artifactRules: [
    "Produce a poster-style HTML artifact with strong hierarchy and composition.",
    "Treat this as an HTML poster surface; do not imply a raster image was generated unless image assets are actually created.",
    "Make the poster responsive enough to inspect on mobile and desktop.",
    "Keep text deliberate and avoid placeholder copy.",
  ],
});

export const dashboardDesignCommand = createArtifactGenerateCommand({
  target: "dashboard-design",
  description: "Generate a dashboard design from a prompt",
  examples: `  Generate dash design: okou generate dashboard-design --prompt "An ops dashboard for generation runs"
  Custom site slug:      okou generate dashboard-design --site-slug generation-ops --prompt "A generation ops dashboard"
  Show choices:          okou generate dashboard-design`,
  artifactRules: [
    "Produce a dashboard design mockup, not a live operational dashboard.",
    "Include scannable KPIs, chart-like visuals, lists or tables, and realistic empty/loading/error states as static design content.",
    "Prioritize dense, repeat-use UI over decorative sections.",
    "Verify the dashboard does not overflow at desktop and mobile widths.",
  ],
});

export const mobileAppDesignCommand = createArtifactGenerateCommand({
  target: "mobile-app-design",
  description: "Generate a mobile app design prototype from a prompt",
  examples: `  Generate mobile UI:   okou generate mobile-app-design --prompt "A mobile review screen for generation artifacts"
  Custom site slug:      okou generate mobile-app-design --site-slug generation-mobile-review --prompt "A mobile review screen"
  Show choices:          okou generate mobile-app-design`,
  artifactRules: [
    "Produce a design prototype, not a runnable or installable mobile app.",
    "Render the design inside a realistic phone frame with status bar, device chrome, and home indicator when possible.",
    "Focus on one mobile screen and one primary job.",
    "Use mobile-appropriate tap targets, type sizes, and spacing.",
  ],
});
