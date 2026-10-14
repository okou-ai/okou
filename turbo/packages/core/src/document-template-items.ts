// Native document adaptations. Provenance and licenses are bundled with the pinned resource.
export const DOCUMENT_TEMPLATE_CATEGORIES = [
  "all",
  "creative-brief",
  "contract",
  "service-agreement",
  "invoice",
  "report",
  "guide",
  "letter",
  "business-record",
  "resume",
] as const;
export type DocumentTemplateCategory = Exclude<
  (typeof DOCUMENT_TEMPLATE_CATEGORIES)[number],
  "all"
>;
export interface DocumentTemplateItem {
  readonly id: `document-template:${string}`;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly category: DocumentTemplateCategory;
  readonly previewImageUrl: string;
  readonly previewPages: readonly string[];
}

export const DOCUMENT_TEMPLATE_PACKAGE = {
  resourceId: "template:document-builtins-v1",
  slug: "document-builtins-v1",
  sha256: "4c45092bc4e4ad21feba51339f38ad4283e021ba2de7150ee7094d63e9f151a4",
  versionId: "32956ab324f720a92d1ba4f574bd9e1bad8307bb3fe4538d4e0708b2c1a3bdcd",
} as const;

export const DOCUMENT_TEMPLATE_ITEMS: readonly DocumentTemplateItem[] = [
  {
    id: "document-template:content-brief",
    slug: "document-content-brief",
    title: "Content brief",
    description:
      "Commission articles, guides, and case studies with an editorial and SEO brief.",
    category: "creative-brief",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-content-brief/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-content-brief/page-01.webp",
    ],
  },
  {
    id: "document-template:creative-brief",
    slug: "document-creative-brief",
    title: "Creative brief",
    description:
      "Align a campaign around an audience insight, message, and deliverables.",
    category: "creative-brief",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-creative-brief/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-creative-brief/page-01.webp",
    ],
  },
  {
    id: "document-template:visual-production-brief",
    slug: "document-visual-production-brief",
    title: "Visual production brief",
    description: "Translate a creative idea into a visual production plan.",
    category: "creative-brief",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-visual-production-brief/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-visual-production-brief/page-01.webp",
    ],
  },
  {
    id: "document-template:photography-brief",
    slug: "document-photography-brief",
    title: "Photography brief",
    description:
      "Plan a shoot with shot lists, lighting, usage, and delivery requirements.",
    category: "creative-brief",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-photography-brief/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-photography-brief/page-01.webp",
    ],
  },
  {
    id: "document-template:illustration-brief",
    slug: "document-illustration-brief",
    title: "Illustration brief",
    description:
      "Commission illustrations with composition, usage, and artwork specifications.",
    category: "creative-brief",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-illustration-brief/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-illustration-brief/page-01.webp",
    ],
  },
  {
    id: "document-template:creative-direction-brief",
    slug: "document-creative-direction-brief",
    title: "Creative direction brief",
    description:
      "Define a creative territory and the decisions needed to approve it.",
    category: "creative-brief",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-creative-direction-brief/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-creative-direction-brief/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-creative-direction-brief/page-02.webp",
    ],
  },
  {
    id: "document-template:ugc-video-brief",
    slug: "document-ugc-video-brief",
    title: "UGC video brief",
    description:
      "Plan creator-led video with hooks, story beats, and production guidance.",
    category: "creative-brief",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-ugc-video-brief/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-ugc-video-brief/page-01.webp",
    ],
  },
  {
    id: "document-template:mutual-nda",
    slug: "document-mutual-nda",
    title: "Mutual NDA",
    description:
      "Mutual confidentiality agreement with clearly identified parties and purpose.",
    category: "contract",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-mutual-nda/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-mutual-nda/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-mutual-nda/page-02.webp",
    ],
  },
  {
    id: "document-template:employee-ip-agreement",
    slug: "document-employee-ip-agreement",
    title: "Employee IP agreement",
    description:
      "Separate work-related inventions from personal employee projects.",
    category: "contract",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-employee-ip-agreement/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-employee-ip-agreement/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-employee-ip-agreement/page-02.webp",
    ],
  },
  {
    id: "document-template:fixed-price-contract",
    slug: "document-fixed-price-contract",
    title: "Fixed-price contract",
    description:
      "Define a fixed-price project, milestones, and change approval.",
    category: "contract",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-fixed-price-contract/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-fixed-price-contract/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-fixed-price-contract/page-02.webp",
    ],
  },
  {
    id: "document-template:us-employment-offer",
    slug: "document-us-employment-offer",
    title: "US employment offer",
    description:
      "A US employment offer structure; employment terms remain jurisdiction-specific.",
    category: "contract",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-us-employment-offer/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-us-employment-offer/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-us-employment-offer/page-02.webp",
    ],
  },
  {
    id: "document-template:freelance-hourly-contract",
    slug: "document-freelance-hourly-contract",
    title: "Freelance hourly contract",
    description:
      "Define an hourly freelance engagement and reporting obligations.",
    category: "contract",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-freelance-hourly-contract/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-freelance-hourly-contract/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-freelance-hourly-contract/page-02.webp",
    ],
  },
  {
    id: "document-template:employee-nda",
    slug: "document-employee-nda",
    title: "Employee NDA",
    description:
      "Document employee confidentiality obligations and exceptions.",
    category: "contract",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-employee-nda/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-employee-nda/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-employee-nda/page-02.webp",
    ],
  },
  {
    id: "document-template:plain-language-contract",
    slug: "document-plain-language-contract",
    title: "Plain-language contract",
    description:
      "Plain-language agreement with readable sections and signature fields.",
    category: "contract",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-plain-language-contract/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-plain-language-contract/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-plain-language-contract/page-02.webp",
    ],
  },
  {
    id: "document-template:monthly-services",
    slug: "document-monthly-services",
    title: "Monthly services",
    description:
      "Define recurring services, included work, and cancellation terms.",
    category: "service-agreement",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-monthly-services/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-monthly-services/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-monthly-services/page-02.webp",
    ],
  },
  {
    id: "document-template:website-services",
    slug: "document-website-services",
    title: "Website services",
    description:
      "Agree website deliverables, revisions, maintenance, and ownership.",
    category: "service-agreement",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-website-services/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-website-services/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-website-services/page-02.webp",
    ],
  },
  {
    id: "document-template:studio-services",
    slug: "document-studio-services",
    title: "Studio services",
    description:
      "Scope a studio engagement with fees, revisions, and approval stages.",
    category: "service-agreement",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-studio-services/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-studio-services/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-studio-services/page-02.webp",
    ],
  },
  {
    id: "document-template:software-consulting",
    slug: "document-software-consulting",
    title: "Software consulting",
    description:
      "Set out a software consulting engagement and deliverable acceptance.",
    category: "service-agreement",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-software-consulting/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-software-consulting/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-software-consulting/page-02.webp",
    ],
  },
  {
    id: "document-template:design-services",
    slug: "document-design-services",
    title: "Design services",
    description:
      "Define design services, review stages, and intellectual property.",
    category: "service-agreement",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-design-services/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-design-services/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-design-services/page-02.webp",
    ],
  },
  {
    id: "document-template:cloud-services",
    slug: "document-cloud-services",
    title: "Cloud services",
    description: "Structure a cloud-services order and its contractual terms.",
    category: "service-agreement",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-cloud-services/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-cloud-services/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-cloud-services/page-02.webp",
    ],
  },
  {
    id: "document-template:ai-consulting",
    slug: "document-ai-consulting",
    title: "AI consulting",
    description:
      "Define an AI consulting engagement, data access, and deliverables.",
    category: "service-agreement",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-ai-consulting/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-ai-consulting/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-ai-consulting/page-02.webp",
    ],
  },
  {
    id: "document-template:itemized-invoice",
    slug: "document-itemized-invoice",
    title: "Itemized invoice",
    description:
      "A commercial invoice with editable line items, totals, and payment details.",
    category: "invoice",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-itemized-invoice/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-itemized-invoice/page-01.webp",
    ],
  },
  {
    id: "document-template:signed-invoice",
    slug: "document-signed-invoice",
    title: "Signed invoice",
    description:
      "A commercial invoice with editable line items, totals, and payment details.",
    category: "invoice",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-signed-invoice/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-signed-invoice/page-01.webp",
    ],
  },
  {
    id: "document-template:detailed-invoice",
    slug: "document-detailed-invoice",
    title: "Detailed invoice",
    description:
      "A commercial invoice with editable line items, totals, and payment details.",
    category: "invoice",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-detailed-invoice/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-detailed-invoice/page-01.webp",
    ],
  },
  {
    id: "document-template:simple-invoice",
    slug: "document-simple-invoice",
    title: "Simple invoice",
    description:
      "A commercial invoice with editable line items, totals, and payment details.",
    category: "invoice",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-simple-invoice/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-simple-invoice/page-01.webp",
    ],
  },
  {
    id: "document-template:three-column-invoice",
    slug: "document-three-column-invoice",
    title: "Three-column invoice",
    description:
      "A commercial invoice with editable line items, totals, and payment details.",
    category: "invoice",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-three-column-invoice/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-three-column-invoice/page-01.webp",
    ],
  },
  {
    id: "document-template:monospace-invoice",
    slug: "document-monospace-invoice",
    title: "Monospace invoice",
    description:
      "A commercial invoice with editable line items, totals, and payment details.",
    category: "invoice",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-monospace-invoice/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-monospace-invoice/page-01.webp",
    ],
  },
  {
    id: "document-template:basic-invoice",
    slug: "document-basic-invoice",
    title: "Basic invoice",
    description:
      "A commercial invoice with editable line items, totals, and payment details.",
    category: "invoice",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-basic-invoice/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-basic-invoice/page-01.webp",
    ],
  },
  {
    id: "document-template:two-column-report",
    slug: "document-two-column-report",
    title: "Two-column report",
    description:
      "A structured report with evidence, findings, and recommendations.",
    category: "report",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-two-column-report/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-two-column-report/page-01.webp",
    ],
  },
  {
    id: "document-template:charts-report",
    slug: "document-charts-report",
    title: "Charts report",
    description:
      "A structured report with evidence, findings, and recommendations.",
    category: "report",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-charts-report/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-charts-report/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-charts-report/page-02.webp",
    ],
  },
  {
    id: "document-template:research-paper",
    slug: "document-research-paper",
    title: "Research paper",
    description:
      "A structured report with evidence, findings, and recommendations.",
    category: "report",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-research-paper/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-research-paper/page-01.webp",
    ],
  },
  {
    id: "document-template:elegant-paper",
    slug: "document-elegant-paper",
    title: "Elegant paper",
    description:
      "A structured report with evidence, findings, and recommendations.",
    category: "report",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-elegant-paper/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-elegant-paper/page-01.webp",
    ],
  },
  {
    id: "document-template:department-newsletter",
    slug: "document-department-newsletter",
    title: "Department newsletter",
    description:
      "A structured report with evidence, findings, and recommendations.",
    category: "report",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-department-newsletter/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-department-newsletter/page-01.webp",
    ],
  },
  {
    id: "document-template:elegant-handbook",
    slug: "document-elegant-handbook",
    title: "Elegant handbook",
    description:
      "A practical guide with chapters, instructions, and checklists.",
    category: "guide",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-elegant-handbook/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-elegant-handbook/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-elegant-handbook/page-02.webp",
    ],
  },
  {
    id: "document-template:margin-note-handout",
    slug: "document-margin-note-handout",
    title: "Margin-note handout",
    description:
      "A practical guide with chapters, instructions, and checklists.",
    category: "guide",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-margin-note-handout/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-margin-note-handout/page-01.webp",
    ],
  },
  {
    id: "document-template:knowledge-handbook",
    slug: "document-knowledge-handbook",
    title: "Knowledge handbook",
    description:
      "A practical guide with chapters, instructions, and checklists.",
    category: "guide",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-knowledge-handbook/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-knowledge-handbook/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-knowledge-handbook/page-02.webp",
    ],
  },
  {
    id: "document-template:elegant-notes",
    slug: "document-elegant-notes",
    title: "Elegant notes",
    description:
      "A practical guide with chapters, instructions, and checklists.",
    category: "guide",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-elegant-notes/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-elegant-notes/page-01.webp",
    ],
  },
  {
    id: "document-template:technical-guide",
    slug: "document-technical-guide",
    title: "Technical guide",
    description:
      "A practical guide with chapters, instructions, and checklists.",
    category: "guide",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-technical-guide/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-technical-guide/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-technical-guide/page-02.webp",
    ],
  },
  {
    id: "document-template:orange-chapter-book",
    slug: "document-orange-chapter-book",
    title: "Orange chapter book",
    description:
      "A practical guide with chapters, instructions, and checklists.",
    category: "guide",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-orange-chapter-book/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-orange-chapter-book/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-orange-chapter-book/page-02.webp",
    ],
  },
  {
    id: "document-template:business-letter",
    slug: "document-business-letter",
    title: "Business letter",
    description:
      "An editable business letter with recipient details and a signature.",
    category: "letter",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-business-letter/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-business-letter/page-01.webp",
    ],
  },
  {
    id: "document-template:appreciation-letter",
    slug: "document-appreciation-letter",
    title: "Appreciation letter",
    description:
      "An editable business letter with recipient details and a signature.",
    category: "letter",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-appreciation-letter/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-appreciation-letter/page-01.webp",
    ],
  },
  {
    id: "document-template:professional-letter",
    slug: "document-professional-letter",
    title: "Professional letter",
    description:
      "An editable business letter with recipient details and a signature.",
    category: "letter",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-professional-letter/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-professional-letter/page-01.webp",
    ],
  },
  {
    id: "document-template:receipt",
    slug: "document-receipt",
    title: "Receipt",
    description:
      "A structured business record with editable amounts and approval fields.",
    category: "business-record",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-receipt/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-receipt/page-01.webp",
    ],
  },
  {
    id: "document-template:multi-page-quotation",
    slug: "document-multi-page-quotation",
    title: "Multi-page quotation",
    description:
      "A structured business record with editable amounts and approval fields.",
    category: "business-record",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-multi-page-quotation/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-multi-page-quotation/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-multi-page-quotation/page-02.webp",
    ],
  },
  {
    id: "document-template:timesheet",
    slug: "document-timesheet",
    title: "Timesheet",
    description:
      "A structured business record with editable amounts and approval fields.",
    category: "business-record",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-timesheet/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-timesheet/page-01.webp",
    ],
  },
  {
    id: "document-template:awesome-resume",
    slug: "document-awesome-resume",
    title: "Awesome resume",
    description:
      "An editable career document with clear experience and qualification sections.",
    category: "resume",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-awesome-resume/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-awesome-resume/page-01.webp",
    ],
  },
  {
    id: "document-template:matching-cover-letter",
    slug: "document-matching-cover-letter",
    title: "Matching cover letter",
    description:
      "An editable career document with clear experience and qualification sections.",
    category: "resume",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-matching-cover-letter/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-matching-cover-letter/page-01.webp",
    ],
  },
  {
    id: "document-template:minimal-resume",
    slug: "document-minimal-resume",
    title: "Minimal resume",
    description:
      "An editable career document with clear experience and qualification sections.",
    category: "resume",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-minimal-resume/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-minimal-resume/page-01.webp",
    ],
  },
  {
    id: "document-template:two-column-resume",
    slug: "document-two-column-resume",
    title: "Two-column resume",
    description:
      "An editable career document with clear experience and qualification sections.",
    category: "resume",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-two-column-resume/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-two-column-resume/page-01.webp",
    ],
  },
  {
    id: "document-template:sidebar-resume",
    slug: "document-sidebar-resume",
    title: "Sidebar resume",
    description:
      "An editable career document with clear experience and qualification sections.",
    category: "resume",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-sidebar-resume/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-sidebar-resume/page-01.webp",
    ],
  },
  {
    id: "document-template:classic-resume",
    slug: "document-classic-resume",
    title: "Classic resume",
    description:
      "An editable career document with clear experience and qualification sections.",
    category: "resume",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-classic-resume/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-builtins-v1-20261014-622033b490b8/document-classic-resume/page-01.webp",
    ],
  },
];

export function findDocumentTemplateItem(
  id: string,
): DocumentTemplateItem | undefined {
  return DOCUMENT_TEMPLATE_ITEMS.find((item) => {
    return item.id === id || item.slug === id;
  });
}
