// Curated public GitHub sources pinned to immutable commits.
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
  readonly source: {
    readonly repo: string;
    readonly ref: string;
    readonly path: string;
    readonly supportingPaths?: readonly string[];
    readonly licensePath: string;
  };
  readonly previewImageUrl: string;
  readonly previewPages: readonly string[];
}

export const DOCUMENT_TEMPLATE_ITEMS: readonly DocumentTemplateItem[] = [
  {
    id: "document-template:content-brief",
    slug: "document-content-brief",
    source: {
      repo: "alirezarezvani/claude-skills",
      ref: "19392f7a08264ed00486a251f5b2098321771f94",
      path: "marketing-skill/skills/content-production/templates/content-brief-template.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "rampstackco/claude-skills",
      ref: "482c9bf74697fc1e311bd4dca5ce301f046c4b76",
      path: "skills/creative-brief/references/creative-brief-template.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "rampstackco/claude-skills",
      ref: "482c9bf74697fc1e311bd4dca5ce301f046c4b76",
      path: "skills/art-direction/references/creative-brief-template.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "rampstackco/claude-skills",
      ref: "482c9bf74697fc1e311bd4dca5ce301f046c4b76",
      path: "skills/art-direction/references/photo-shoot-brief.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "rampstackco/claude-skills",
      ref: "482c9bf74697fc1e311bd4dca5ce301f046c4b76",
      path: "skills/art-direction/references/illustration-brief.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "rampstackco/claude-skills",
      ref: "482c9bf74697fc1e311bd4dca5ce301f046c4b76",
      path: "skills/creative-direction/references/brief-template.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "TheMattBerman/scrollclaw",
      ref: "ea175d4b62fda3c14f45684bfad519070bd4e7af",
      path: "assets/campaign-brief-template.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "OnedocLabs/react-print-pdf",
      ref: "f1023fe7b335f228c85ec3a7c0a151fd3d69e22f",
      path: "src/ui/templates/nda-markdown.mdx",
      licensePath: "LICENSE.md",
    },
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
    source: {
      repo: "github/balanced-employee-ip-agreement",
      ref: "47a1eaf847379cb99006ce34cd92c71dd93ec35c",
      path: "Balanced_Employee_IP_Agreement.md",
      licensePath: "LICENSE.md",
    },
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
    source: {
      repo: "Oak-Harbor-Kits/Contract-Templates",
      ref: "4e49c669fa1e856d583723f0a60175533645b680",
      path: "Lump Sum Contract Template.docx",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "Automattic/legalmattic",
      ref: "99aa482bf6b602645bcb50c47a68db48a76dbce0",
      path: "Offer Letters/United States.md",
      licensePath: "LICENSE.txt",
    },
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
    source: {
      repo: "ashedryden/freelance-contract",
      ref: "5721d1cc52ee37da25438d1dada05b8fc36c1e83",
      path: "README.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "papertrail/legal-docs",
      ref: "ee04a2300c4a2c80a6ec17e46bdc745685e249de",
      path: "employee-nda.md",
      licensePath: "README.md",
    },
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
    source: {
      repo: "jackmorgan/the-plain-contract",
      ref: "140b70240e177fa8390304982cad2a35fd5bf890",
      path: "The Plain Contract 1.0.docx",
      licensePath: "README.md",
    },
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
    source: {
      repo: "Oak-Harbor-Kits/Contract-Templates",
      ref: "4e49c669fa1e856d583723f0a60175533645b680",
      path: "Monthly Subscription Contract Template.docx",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "nonsalant/contract",
      ref: "dc13c23ee2915e3d2175370f0ea4ba8f37b58f0d",
      path: "generator/data/contract-content.html",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "mds/sa",
      ref: "8d899bde0b724fb7e3b0eb5da605c3ed8453b311",
      path: "service-agreement.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "shimon/consulting-contract-template",
      ref: "632aabc5536e2c1a8292157fd83f815829160785",
      path: "contract.latex",
      licensePath: "README.md",
    },
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
    source: {
      repo: "studionaeo/design-services-standard-agreement",
      ref: "df71218eb1d5c5a59efb1ceb80de56a9935d6420",
      path: "协议/设计服务标准协议书.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "CommonPaper/CSA",
      ref: "3efceb01e3c8bfb7b302a5f34975aa2b084026a3",
      path: "CSA.md",
      licensePath: "README.md",
    },
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
    source: {
      repo: "zackthoutt/ai-consulting",
      ref: "a951502e4e09f128ba9232ba6c2b82a7c193596d",
      path: "contract.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "ad-si/invoice-maker",
      ref: "5c6fc1ffaa0a149624808b2f221c07c9fa6c94de",
      path: "invoice-maker.typ",
      licensePath: "license.txt",
    },
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
    source: {
      repo: "erictapen/typst-invoice",
      ref: "478a76b8d95ad2a954eebd8bf596ccb061985166",
      path: "template/main.typ",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "OnedocLabs/react-print-pdf",
      ref: "f1023fe7b335f228c85ec3a7c0a151fd3d69e22f",
      path: "src/ui/templates/invoice-advanced.mdx",
      licensePath: "LICENSE.md",
    },
    title: "Detailed invoice",
    description:
      "A purple payment card with a QR code, billing details, line items, and payment terms.",
    category: "invoice",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-detailed-invoice/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-detailed-invoice/page-01.webp",
    ],
  },
  {
    id: "document-template:simple-invoice",
    slug: "document-simple-invoice",
    source: {
      repo: "sparksuite/simple-html-invoice-template",
      ref: "7d74fe34c862b7712f1a23a3f12147a4a8bd53e1",
      path: "invoice.html",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "htmldocs-js/htmldocs",
      ref: "26f8b27ab2a03ac62f3d22971bb23bfbc43c8971",
      path: "apps/examples/documents/templates/Invoice.tsx",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "usgraphics/usgc-invoice",
      ref: "f93cddcf53f80a842bf0437f5ea6232ecbd095ab",
      path: "usgc-invoice.typ",
      licensePath: "LICENSE",
    },
    title: "Monospace invoice",
    description:
      "A USGC invoice with typewriter typography, ruled item rows, and a payment ledger.",
    category: "invoice",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-monospace-invoice/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-monospace-invoice/page-01.webp",
    ],
  },
  {
    id: "document-template:basic-invoice",
    slug: "document-basic-invoice",
    source: {
      repo: "OnedocLabs/react-print-pdf",
      ref: "f1023fe7b335f228c85ec3a7c0a151fd3d69e22f",
      path: "src/ui/templates/invoice.mdx",
      licensePath: "LICENSE.md",
    },
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
    source: {
      repo: "Wandmalfarbe/pandoc-latex-template",
      ref: "93cc5b8e08c658da012d7609491ae72b1aff72fc",
      path: "examples/columns/document.md",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "OnedocLabs/react-print-pdf",
      ref: "f1023fe7b335f228c85ec3a7c0a151fd3d69e22f",
      path: "src/ui/templates/report-charts.mdx",
      licensePath: "LICENSE.md",
    },
    title: "Charts report",
    description:
      "A monthly usage report built around a stacked bar chart and colorful breakdown cards.",
    category: "report",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-charts-report/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-charts-report/page-01.webp",
    ],
  },
  {
    id: "document-template:sidebar-report",
    slug: "document-sidebar-report",
    source: {
      repo: "RelaxedJS/ReLaXed-examples",
      ref: "378a2d4f34ffe8ffd61e956e02a50b15564fc9f6",
      path: "examples/report/report.pug",
      supportingPaths: [
        "examples/report/report.scss",
        "examples/report/report.pdf",
      ],
      licensePath: "LICENCE.txt",
    },
    title: "Sidebar report",
    description:
      "A ReLaXed explainer with a colored side band, summary, comparison table, and diagrams.",
    category: "report",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-sidebar-report/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-sidebar-report/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-sidebar-report/page-02.webp",
    ],
  },
  {
    id: "document-template:research-paper",
    slug: "document-research-paper",
    source: {
      repo: "kourgeorge/arxiv-style",
      ref: "920514696f6e7270cab0558fd97c44515c63b4c4",
      path: "template.tex",
      licensePath: "License.txt",
    },
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
    source: {
      repo: "ElegantLaTeX/ElegantPaper",
      ref: "40275032d6e3073e658038de30a98e1b4785f052",
      path: "elegantpaper.cls",
      licensePath: "License",
    },
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
    source: {
      repo: "typst/templates",
      ref: "71b01c6b0a828649c7a0a38e8167cd82aab76efc",
      path: "dashing-dept-news/template/main.typ",
      supportingPaths: [
        "dashing-dept-news/lib.typ",
        "dashing-dept-news/typst.toml",
      ],
      licensePath: "dashing-dept-news/LICENSE",
    },
    title: "Department newsletter",
    description:
      "A magazine-style newsletter with a hero photo, bold headlines, pull quotes, and a red news sidebar.",
    category: "report",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-department-newsletter/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-department-newsletter/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-department-newsletter/page-02.webp",
    ],
  },
  {
    id: "document-template:elegant-handbook",
    slug: "document-elegant-handbook",
    source: {
      repo: "ElegantLaTeX/ElegantBook",
      ref: "8b90c11e4a5ffd9d1e07174011303c133093d09c",
      path: "elegantbook.cls",
      licensePath: "License",
    },
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
    source: {
      repo: "Tufte-LaTeX/tufte-latex",
      ref: "efb8c8e836890bad71fb5834acdd316ebde6db12",
      path: "sample-handout.tex",
      licensePath: "README.md",
    },
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
    source: {
      repo: "fmarotta/kaobook",
      ref: "22225a174f1b667a50c0a80afb48c498e8126dc1",
      path: "examples/documentation/main.tex",
      supportingPaths: [
        "kaobook.cls",
        "kao.sty",
        "examples/documentation/main.pdf",
      ],
      licensePath: "LICENSE",
    },
    title: "Knowledge handbook",
    description:
      "A kaobook handbook combining chapters, wide-margin notes, figures, references, and an index.",
    category: "guide",
    previewImageUrl:
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-knowledge-handbook/cover.webp",
    previewPages: [
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-knowledge-handbook/page-01.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-knowledge-handbook/page-02.webp",
      "https://static.vm0.io/vm0/artifact-templates/document/document-originals-v1-20261019-0441a6cec2b2/document-knowledge-handbook/page-03.webp",
    ],
  },
  {
    id: "document-template:elegant-notes",
    slug: "document-elegant-notes",
    source: {
      repo: "ElegantLaTeX/ElegantNote",
      ref: "e45cde75e4d265f72042097cd10be03a961440c3",
      path: "elegantnote.cls",
      licensePath: "License",
    },
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
    source: {
      repo: "SiriusFzh/NovaForge",
      ref: "bb68c0e644b8909cbfee5416cf20cf19e85d207c",
      path: "latex/template.tex",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "flavio20002/typst-orange-template",
      ref: "92eeccb8199f0e68fbf4726486bc6cd7ccd0e1a3",
      path: "tests/heading-style/test.typ",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "cmichi/latex-template-collection",
      ref: "a6a9082eadec9553fc36c8a18a360461ac569162",
      path: "letter/letter.tex",
      licensePath: "README.md",
    },
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
    source: {
      repo: "typst/templates",
      ref: "71b01c6b0a828649c7a0a38e8167cd82aab76efc",
      path: "appreciated-letter/template/main.typ",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "Sematre/typst-letter-pro",
      ref: "3a7109f78dbd277ac476e02ed2fe7624bc004b4b",
      path: "template/src/main.typ",
      licensePath: "LICENSE",
    },
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
    source: {
      repo: "OnedocLabs/react-print-pdf",
      ref: "f1023fe7b335f228c85ec3a7c0a151fd3d69e22f",
      path: "src/ui/templates/receipt.mdx",
      licensePath: "LICENSE.md",
    },
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
    source: {
      repo: "cmichi/latex-template-collection",
      ref: "a6a9082eadec9553fc36c8a18a360461ac569162",
      path: "invoice-multiple-pages/angebot.tex",
      licensePath: "README.md",
    },
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
    source: {
      repo: "cmichi/latex-template-collection",
      ref: "a6a9082eadec9553fc36c8a18a360461ac569162",
      path: "timesheet/timesheet.tex",
      licensePath: "README.md",
    },
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
];

export function findDocumentTemplateItem(
  id: string,
): DocumentTemplateItem | undefined {
  return DOCUMENT_TEMPLATE_ITEMS.find((item) => {
    return item.id === id || item.slug === id;
  });
}
