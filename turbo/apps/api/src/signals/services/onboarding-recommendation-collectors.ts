import type { OnboardingRecommendationConnectorSlug } from "@okouai/api-contracts/contracts/onboarding";

import { readBoundedResponseText, safeJsonParse } from "../utils";

const PROVIDER_TIMEOUT_MS = 8000;
const PROVIDER_RESPONSE_MAX_BYTES = 128 * 1024;
const MAX_FACTS = 18;
const MAX_FACT_LENGTH = 280;

export interface OnboardingConnectorContext {
  readonly sourceSlug: OnboardingRecommendationConnectorSlug;
  readonly facts: readonly string[];
  readonly capabilities: readonly string[];
}

export interface OnboardingCollectorInput {
  readonly now: Date;
  readonly oauthScopes: readonly string[] | null;
  readonly values: ReadonlyMap<string, string>;
}

type OnboardingContextCollector = (
  input: OnboardingCollectorInput,
  signal: AbortSignal,
) => Promise<OnboardingConnectorContext>;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function records(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const item = record(entry);
        return item === null ? [] : [item];
      })
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sanitizeText(value: string, maxLength = MAX_FACT_LENGTH): string {
  const withoutControlCharacters = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
      ? " "
      : character;
  }).join("");
  const sanitized = withoutControlCharacters
    .replaceAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[email]")
    .replaceAll(/https?:\/\/\S+/giu, "[link]")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return sanitized.length <= maxLength
    ? sanitized
    : `${sanitized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function boundedFacts(facts: readonly (string | null | undefined)[]): string[] {
  const normalized: string[] = [];
  for (const fact of facts) {
    if (!fact) {
      continue;
    }
    const value = sanitizeText(fact);
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
    if (normalized.length >= MAX_FACTS) {
      break;
    }
  }
  return normalized;
}

function requiredValue(
  values: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = values.get(name);
  if (!value) {
    throw new Error("Connector context credential is unavailable");
  }
  return value;
}

async function providerJson(
  args: {
    readonly url: string;
    readonly token: string;
    readonly method?: "GET" | "POST";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  },
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(args.url, {
    method: args.method ?? "GET",
    headers: {
      Authorization: `Bearer ${args.token}`,
      Accept: "application/json",
      ...(args.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...args.headers,
    },
    ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]),
  });
  const body = await readBoundedResponseText(
    response,
    PROVIDER_RESPONSE_MAX_BYTES,
  );
  signal.throwIfAborted();
  if (!response.ok || body.kind !== "text") {
    throw new Error(`Connector context request failed (${response.status})`);
  }
  const parsed = safeJsonParse(body.text);
  if (parsed === undefined) {
    throw new Error("Connector context response was not JSON");
  }
  return parsed;
}

const CONNECTOR_CAPABILITIES = {
  gmail: ["search email", "draft replies", "scheduled inbox checks"],
  "google-docs": [
    "read documents",
    "draft document updates",
    "scheduled document reviews",
  ],
  "google-drive": ["find files", "organize files", "scheduled file reviews"],
  "google-sheets": [
    "read spreadsheets",
    "draft spreadsheet updates",
    "recurring reports",
  ],
  github: [
    "read repositories and work items",
    "draft issue or pull-request follow-ups",
    "scheduled repository checks",
  ],
  quickbooks: [
    "read accounting reports",
    "review invoices and bills",
    "scheduled finance checks",
  ],
  hubspot: [
    "read CRM records",
    "draft follow-ups",
    "scheduled pipeline checks",
  ],
  linear: [
    "read projects and issues",
    "draft issue follow-ups",
    "scheduled project checks",
  ],
  notion: [
    "read pages and databases",
    "draft structured updates",
    "scheduled workspace checks",
  ],
  "google-calendar": [
    "read schedules",
    "draft agendas and follow-ups",
    "recurring calendar checks",
  ],
  "outlook-mail": ["search email", "draft replies", "scheduled inbox checks"],
  "google-ads": [
    "read campaign performance",
    "draft optimization plans",
    "recurring performance checks",
  ],
  "meta-ads": [
    "read campaign performance",
    "draft optimization plans",
    "recurring performance checks",
  ],
} as const satisfies Readonly<
  Record<OnboardingRecommendationConnectorSlug, readonly string[]>
>;

export function onboardingConnectorCapabilityContext(
  sourceSlug: OnboardingRecommendationConnectorSlug,
): OnboardingConnectorContext {
  return {
    sourceSlug,
    facts: [],
    capabilities: CONNECTOR_CAPABILITIES[sourceSlug],
  };
}

function context(
  sourceSlug: OnboardingRecommendationConnectorSlug,
  facts: readonly (string | null | undefined)[],
): OnboardingConnectorContext {
  const bounded = boundedFacts(facts);
  if (bounded.length === 0) {
    throw new Error("Connector context response had no useful facts");
  }
  return {
    sourceSlug,
    facts: bounded,
    capabilities: CONNECTOR_CAPABILITIES[sourceSlug],
  };
}

function queryUrl(
  base: string,
  query: Readonly<Record<string, string | readonly string[]>>,
): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") {
      url.searchParams.set(key, value);
      continue;
    }
    for (const item of value) {
      url.searchParams.append(key, item);
    }
  }
  return url.toString();
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function daysAfter(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

function timestampValue(value: unknown): number | null {
  const text = stringValue(value);
  if (text === null) {
    return null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function emailHeader(message: JsonRecord, name: string): string | null {
  const payload = record(message.payload);
  const header = records(payload?.headers).find((candidate) => {
    return stringValue(candidate.name)?.toLowerCase() === name.toLowerCase();
  });
  return stringValue(header?.value);
}

function senderDomain(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const match = /@([A-Z0-9.-]+\.[A-Z]{2,})/iu.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

const collectGmail: OnboardingContextCollector = async (input, signal) => {
  const token = requiredValue(input.values, "GMAIL_TOKEN");
  const [inboxBody, messagesBody] = await Promise.all([
    providerJson(
      {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX",
        token,
      },
      signal,
    ),
    providerJson(
      {
        url: queryUrl(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages",
          {
            maxResults: "5",
            q: "newer_than:14d",
          },
        ),
        token,
      },
      signal,
    ),
  ]);
  const inbox = record(inboxBody);
  const messages = records(record(messagesBody)?.messages).slice(0, 2);
  const details = await Promise.all(
    messages.flatMap((message) => {
      const id = stringValue(message.id);
      return id === null
        ? []
        : [
            providerJson(
              {
                url: queryUrl(
                  `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
                  {
                    format: "metadata",
                    metadataHeaders: ["Subject", "From"],
                  },
                ),
                token,
              },
              signal,
            ),
          ];
    }),
  );
  const recent = details.flatMap((detail) => {
    const message = record(detail);
    if (!message) {
      return [];
    }
    const subject = emailHeader(message, "Subject");
    const domain = senderDomain(emailHeader(message, "From"));
    return subject
      ? [`Recent email subject: ${subject}${domain ? ` (from ${domain})` : ""}`]
      : [];
  });
  return context("gmail", [
    `Inbox contains ${numberValue(inbox?.messagesTotal) ?? "an unknown number of"} messages, with ${numberValue(inbox?.messagesUnread) ?? "an unknown number of"} unread.`,
    ...recent,
  ]);
};

const GOOGLE_DRIVE_FILE_DISCOVERY_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

function canDiscoverGoogleDriveFiles(
  oauthScopes: readonly string[] | null,
): boolean {
  return (
    oauthScopes?.some((scope) => {
      return GOOGLE_DRIVE_FILE_DISCOVERY_SCOPES.some((candidate) => {
        return candidate === scope;
      });
    }) ?? false
  );
}

interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly modifiedTime: string | null;
  readonly mimeType: string | null;
}

async function recentDriveFiles(
  input: OnboardingCollectorInput,
  tokenName: string,
  mimeType: string | undefined,
  signal: AbortSignal,
): Promise<readonly DriveFile[]> {
  const token = requiredValue(input.values, tokenName);
  const q = ["trashed = false", mimeType ? `mimeType = '${mimeType}'` : null]
    .filter(Boolean)
    .join(" and ");
  const body = await providerJson(
    {
      url: queryUrl("https://www.googleapis.com/drive/v3/files", {
        q,
        orderBy: "modifiedTime desc",
        pageSize: "8",
        fields: "files(id,name,modifiedTime,mimeType)",
      }),
      token,
    },
    signal,
  );
  return records(record(body)?.files).flatMap((file) => {
    const id = stringValue(file.id);
    const name = stringValue(file.name);
    return id && name
      ? [
          {
            id,
            name,
            modifiedTime: stringValue(file.modifiedTime),
            mimeType: stringValue(file.mimeType),
          },
        ]
      : [];
  });
}

function paragraphText(paragraph: JsonRecord): string {
  return records(paragraph.elements)
    .flatMap((element) => {
      const textRun = record(element.textRun);
      const content = stringValue(textRun?.content);
      return content ? [content] : [];
    })
    .join(" ");
}

function documentParagraphs(body: unknown): readonly JsonRecord[] {
  const document = record(body);
  const documentBody = record(document?.body);
  return records(documentBody?.content).flatMap((entry) => {
    const paragraph = record(entry.paragraph);
    return paragraph === null ? [] : [paragraph];
  });
}

function documentHeadings(body: unknown): readonly string[] {
  return documentParagraphs(body)
    .flatMap((paragraph) => {
      const style = record(paragraph.paragraphStyle);
      const namedStyle = stringValue(style?.namedStyleType);
      if (!namedStyle?.startsWith("HEADING")) {
        return [];
      }
      const text = sanitizeText(paragraphText(paragraph), 120);
      return text ? [text] : [];
    })
    .slice(0, 8);
}

function documentOpening(body: unknown): string | null {
  const opening = sanitizeText(
    documentParagraphs(body)
      .map((paragraph) => {
        return paragraphText(paragraph);
      })
      .filter(Boolean)
      .join(" "),
    240,
  );
  return opening || null;
}

const collectGoogleDocs: OnboardingContextCollector = async (input, signal) => {
  const token = requiredValue(input.values, "GOOGLE_DOCS_TOKEN");
  if (!canDiscoverGoogleDriveFiles(input.oauthScopes)) {
    return onboardingConnectorCapabilityContext("google-docs");
  }
  const files = await recentDriveFiles(
    input,
    "GOOGLE_DOCS_TOKEN",
    "application/vnd.google-apps.document",
    signal,
  );
  const documents = await Promise.all(
    files.slice(0, 2).map((file) => {
      return providerJson(
        {
          url: `https://docs.googleapis.com/v1/documents/${encodeURIComponent(file.id)}`,
          token,
        },
        signal,
      );
    }),
  );
  return context("google-docs", [
    ...files.map((file) => {
      return `Recent document: ${file.name}${file.modifiedTime ? ` (modified ${file.modifiedTime})` : ""}`;
    }),
    ...documents.flatMap((document) => {
      const opening = documentOpening(document);
      return [
        opening ? `Document opening: ${opening}` : null,
        ...documentHeadings(document).map((heading) => {
          return `Document heading: ${heading}`;
        }),
      ];
    }),
  ]);
};

const collectGoogleDrive: OnboardingContextCollector = async (
  input,
  signal,
) => {
  const files = await recentDriveFiles(
    input,
    "GOOGLE_DRIVE_TOKEN",
    undefined,
    signal,
  );
  const typeCounts = new Map<string, number>();
  for (const file of files) {
    const type = file.mimeType?.split(".").at(-1) ?? "file";
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  return context("google-drive", [
    `Recent file types: ${[...typeCounts.entries()]
      .map(([type, count]) => {
        return `${type} (${count})`;
      })
      .join(", ")}.`,
    ...files.map((file) => {
      return `Recent Drive item: ${file.name}${file.modifiedTime ? ` (modified ${file.modifiedTime})` : ""}`;
    }),
  ]);
};

const collectGoogleSheets: OnboardingContextCollector = async (
  input,
  signal,
) => {
  const token = requiredValue(input.values, "GOOGLE_SHEETS_TOKEN");
  if (!canDiscoverGoogleDriveFiles(input.oauthScopes)) {
    return onboardingConnectorCapabilityContext("google-sheets");
  }
  const files = await recentDriveFiles(
    input,
    "GOOGLE_SHEETS_TOKEN",
    "application/vnd.google-apps.spreadsheet",
    signal,
  );
  const spreadsheets = await Promise.all(
    files.slice(0, 1).map(async (file) => {
      const metadata = await providerJson(
        {
          url: queryUrl(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(file.id)}`,
            {
              includeGridData: "false",
              fields:
                "properties.title,sheets.properties(title,gridProperties)",
            },
          ),
          token,
        },
        signal,
      );
      const spreadsheet = record(metadata);
      const sheets = records(spreadsheet?.sheets);
      const firstTitle = stringValue(record(sheets[0]?.properties)?.title);
      const headerBody = firstTitle
        ? await providerJson(
            {
              url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(file.id)}/values/${encodeURIComponent(`${firstTitle}!A1:Z2`)}`,
              token,
            },
            signal,
          )
        : null;
      return { file, sheets, headerBody };
    }),
  );
  return context("google-sheets", [
    ...files.map((file) => {
      return `Recent spreadsheet: ${file.name}${file.modifiedTime ? ` (modified ${file.modifiedTime})` : ""}`;
    }),
    ...spreadsheets.flatMap(({ file, sheets, headerBody }) => {
      const headerRows = Array.isArray(record(headerBody)?.values)
        ? (record(headerBody)?.values as unknown[])
        : [];
      const rowValues = (row: unknown, limit: number): readonly string[] => {
        return Array.isArray(row)
          ? row
              .flatMap((value) => {
                const text = stringValue(value);
                return text ? [sanitizeText(text, 60)] : [];
              })
              .slice(0, limit)
          : [];
      };
      const headers = rowValues(headerRows[0], 12);
      const sample = rowValues(headerRows[1], 8);
      return [
        `${file.name} has ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}.`,
        headers.length > 0
          ? `${file.name} column headers include: ${headers.join(", ")}.`
          : null,
        sample.length > 0
          ? `${file.name} has a sample row beginning: ${sample.join(", ")}.`
          : null,
      ];
    }),
  ]);
};

const collectGithub: OnboardingContextCollector = async (input, signal) => {
  const token = requiredValue(input.values, "GITHUB_TOKEN");
  const headers = {
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Okou-Onboarding-Context",
  };
  const repositoriesBody = await providerJson(
    {
      url: queryUrl("https://api.github.com/user/repos", {
        sort: "pushed",
        direction: "desc",
        per_page: "8",
        affiliation: "owner,collaborator,organization_member",
      }),
      token,
      headers,
    },
    signal,
  );
  const repositories = records(repositoriesBody).slice(0, 8);
  const active = repositories.slice(0, 2);
  const issueBodies = await Promise.all(
    active.flatMap((repository) => {
      const fullName = stringValue(repository.full_name);
      if (!fullName || !/^[^/]+\/[^/]+$/u.test(fullName)) {
        return [];
      }
      const path = fullName.split("/").map(encodeURIComponent).join("/");
      return [
        providerJson(
          {
            url: queryUrl(`https://api.github.com/repos/${path}/issues`, {
              state: "open",
              sort: "updated",
              direction: "desc",
              per_page: "8",
            }),
            token,
            headers,
          },
          signal,
        ),
      ];
    }),
  );
  return context("github", [
    ...repositories.map((repository) => {
      const name = stringValue(repository.full_name);
      return name
        ? `Active repository: ${name}; open issues ${numberValue(repository.open_issues_count) ?? "unknown"}; last pushed ${stringValue(repository.pushed_at) ?? "unknown"}.`
        : null;
    }),
    ...issueBodies.flatMap((issues, index) => {
      const repository = stringValue(active[index]?.full_name) ?? "repository";
      return records(issues)
        .slice(0, 5)
        .flatMap((issue) => {
          const title = stringValue(issue.title);
          return title
            ? [
                `${issue.pull_request ? "Open pull request" : "Open issue"} in ${repository}: ${title}`,
              ]
            : [];
        });
    }),
  ]);
};

function quickbooksReportFacts(report: unknown): readonly string[] {
  const facts: string[] = [];
  const visit = (value: unknown): void => {
    if (facts.length >= 8) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    const item = record(value);
    if (!item) {
      return;
    }
    const columns = records(item.ColData);
    const label = stringValue(columns[0]?.value);
    const amount = stringValue(columns[1]?.value);
    if (label && amount && /income|expense|profit|revenue/i.test(label)) {
      facts.push(`${label}: ${amount}`);
    }
    for (const child of Object.values(item)) {
      visit(child);
    }
  };
  visit(report);
  return facts;
}

const collectQuickbooks: OnboardingContextCollector = async (input, signal) => {
  const token = requiredValue(input.values, "QUICKBOOKS_TOKEN");
  const realmId = requiredValue(input.values, "QUICKBOOKS_REALM_ID");
  const base = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}`;
  const invoiceQuery =
    "select * from Invoice where Balance > '0' order by DueDate maxresults 20";
  const billQuery =
    "select * from Bill where Balance > '0' order by DueDate maxresults 20";
  const [companyBody, reportBody, invoicesBody, billsBody] = await Promise.all([
    providerJson(
      {
        url: `${base}/companyinfo/${encodeURIComponent(realmId)}?minorversion=75`,
        token,
      },
      signal,
    ),
    providerJson(
      {
        url: queryUrl(`${base}/reports/ProfitAndLoss`, {
          start_date: isoDate(daysBefore(input.now, 30)),
          end_date: isoDate(input.now),
          minorversion: "75",
        }),
        token,
      },
      signal,
    ),
    providerJson(
      {
        url: queryUrl(`${base}/query`, {
          query: invoiceQuery,
          minorversion: "75",
        }),
        token,
      },
      signal,
    ),
    providerJson(
      {
        url: queryUrl(`${base}/query`, {
          query: billQuery,
          minorversion: "75",
        }),
        token,
      },
      signal,
    ),
  ]);
  const company = record(record(companyBody)?.CompanyInfo);
  const invoices = records(
    record(record(invoicesBody)?.QueryResponse)?.Invoice,
  );
  const bills = records(record(record(billsBody)?.QueryResponse)?.Bill);
  const overdue = invoices.filter((invoice) => {
    const dueDate = stringValue(invoice.DueDate);
    return dueDate !== null && dueDate < isoDate(input.now);
  });
  const overdueBills = bills.filter((bill) => {
    const dueDate = stringValue(bill.DueDate);
    return dueDate !== null && dueDate < isoDate(input.now);
  });
  const openBalance = invoices.reduce((sum, invoice) => {
    return sum + (numberValue(invoice.Balance) ?? 0);
  }, 0);
  const unpaidBillBalance = bills.reduce((sum, bill) => {
    return sum + (numberValue(bill.Balance) ?? 0);
  }, 0);
  return context("quickbooks", [
    company && stringValue(company.CompanyName)
      ? `Company: ${stringValue(company.CompanyName)}.`
      : null,
    `There are ${invoices.length} sampled open invoices totaling ${openBalance.toFixed(2)}; ${overdue.length} are overdue.`,
    `There are ${bills.length} sampled unpaid bills totaling ${unpaidBillBalance.toFixed(2)}; ${overdueBills.length} are overdue.`,
    ...quickbooksReportFacts(reportBody).map((fact) => {
      return `Last 30 days ${fact}.`;
    }),
  ]);
};

const collectHubspot: OnboardingContextCollector = async (input, signal) => {
  const token = requiredValue(input.values, "HUBSPOT_TOKEN");
  const [dealsBody, pipelinesBody] = await Promise.all([
    providerJson(
      {
        url: queryUrl("https://api.hubapi.com/crm/v3/objects/deals", {
          limit: "20",
          archived: "false",
          properties:
            "dealname,amount,dealstage,closedate,hs_lastmodifieddate,hs_is_closed",
        }),
        token,
      },
      signal,
    ),
    providerJson(
      {
        url: "https://api.hubapi.com/crm/v3/pipelines/deals",
        token,
      },
      signal,
    ),
  ]);
  const stageNames = new Map<string, string>();
  for (const pipeline of records(record(pipelinesBody)?.results)) {
    for (const stage of records(pipeline.stages)) {
      const id = stringValue(stage.id);
      const label = stringValue(stage.label);
      if (id && label) {
        stageNames.set(id, label);
      }
    }
  }
  const deals = records(record(dealsBody)?.results);
  const openDeals = deals.filter((deal) => {
    return stringValue(record(deal.properties)?.hs_is_closed) !== "true";
  });
  const staleBefore = daysBefore(input.now, 14).getTime();
  const stalledDeals = openDeals.filter((deal) => {
    const modifiedAt = timestampValue(
      record(deal.properties)?.hs_lastmodifieddate,
    );
    return modifiedAt !== null && modifiedAt < staleBefore;
  });
  const closingSoonLimit = daysAfter(input.now, 30).getTime();
  const closingSoon = openDeals.filter((deal) => {
    const closeAt = timestampValue(record(deal.properties)?.closedate);
    return (
      closeAt !== null &&
      closeAt >= input.now.getTime() &&
      closeAt <= closingSoonLimit
    );
  });
  return context("hubspot", [
    `HubSpot returned ${deals.length} sampled deals across ${stageNames.size} configured stages; ${openDeals.length} are open, ${stalledDeals.length} have not changed in 14 days, and ${closingSoon.length} close in the next 30 days.`,
    ...deals.slice(0, 12).map((deal) => {
      const properties = record(deal.properties);
      const name = stringValue(properties?.dealname);
      if (!name) {
        return null;
      }
      const stageId = stringValue(properties?.dealstage);
      const stage = stageId
        ? (stageNames.get(stageId) ?? stageId)
        : "unknown stage";
      const amount = stringValue(properties?.amount);
      const closeDate = stringValue(properties?.closedate);
      return `Deal: ${name}; stage ${stage}${amount ? `; amount ${amount}` : ""}${closeDate ? `; close date ${closeDate}` : ""}.`;
    }),
  ]);
};

const LINEAR_CONTEXT_QUERY = `query OnboardingContext {
  viewer { assignedIssues(first: 20, orderBy: updatedAt) {
    nodes { title dueDate state { name type } project { name } }
  } }
  projects(first: 8, orderBy: updatedAt) { nodes { name status { name } progress } }
}`;

const collectLinear: OnboardingContextCollector = async (input, signal) => {
  const token = requiredValue(input.values, "LINEAR_TOKEN");
  const body = await providerJson(
    {
      url: "https://api.linear.app/graphql",
      method: "POST",
      token,
      body: { query: LINEAR_CONTEXT_QUERY },
    },
    signal,
  );
  const envelope = record(body);
  if (
    envelope === null ||
    (Array.isArray(envelope.errors) && envelope.errors.length > 0)
  ) {
    throw new Error("Linear context query failed");
  }
  const data = record(envelope.data);
  if (data === null) {
    throw new Error("Linear context query returned no data");
  }
  const viewer = record(data.viewer);
  const assigned = records(record(viewer?.assignedIssues)?.nodes);
  const projects = records(record(data?.projects)?.nodes);
  const blocked = assigned.filter((issue) => {
    return /blocked/iu.test(stringValue(record(issue.state)?.name) ?? "");
  }).length;
  const completed = assigned.filter((issue) => {
    return stringValue(record(issue.state)?.type) === "completed";
  }).length;
  const overdue = assigned.filter((issue) => {
    const stateType = stringValue(record(issue.state)?.type);
    const dueDate = stringValue(issue.dueDate);
    return (
      stateType !== "completed" &&
      stateType !== "canceled" &&
      dueDate !== null &&
      dueDate < isoDate(input.now)
    );
  }).length;
  return context("linear", [
    `Linear returned ${assigned.length} recently updated assigned issues and ${projects.length} projects; ${blocked} issues are blocked, ${overdue} are overdue, and ${completed} are completed.`,
    ...assigned.slice(0, 12).map((issue) => {
      const title = stringValue(issue.title);
      if (!title) {
        return null;
      }
      const state = stringValue(record(issue.state)?.name) ?? "unknown state";
      const project = stringValue(record(issue.project)?.name);
      const due = stringValue(issue.dueDate);
      return `Assigned issue: ${title}; ${state}${project ? `; project ${project}` : ""}${due ? `; due ${due}` : ""}.`;
    }),
    ...projects.slice(0, 5).map((project) => {
      const name = stringValue(project.name);
      return name
        ? `Project: ${name}; status ${stringValue(record(project.status)?.name) ?? "unknown"}; progress ${numberValue(project.progress) ?? "unknown"}.`
        : null;
    }),
  ]);
};

function notionTitle(item: JsonRecord): string | null {
  const direct = records(item.title)
    .map((part) => {
      return stringValue(record(part)?.plain_text);
    })
    .filter((value): value is string => {
      return value !== null;
    })
    .join("");
  if (direct) {
    return direct;
  }
  const properties = record(item.properties);
  if (!properties) {
    return null;
  }
  for (const property of Object.values(properties)) {
    const title = records(record(property)?.title)
      .map((part) => {
        return stringValue(record(part)?.plain_text);
      })
      .filter((value): value is string => {
        return value !== null;
      })
      .join("");
    if (title) {
      return title;
    }
  }
  return null;
}

const collectNotion: OnboardingContextCollector = async (input, signal) => {
  const token = requiredValue(input.values, "NOTION_TOKEN");
  const body = await providerJson(
    {
      url: "https://api.notion.com/v1/search",
      method: "POST",
      token,
      headers: { "Notion-Version": "2022-06-28" },
      body: {
        page_size: 20,
        sort: { direction: "descending", timestamp: "last_edited_time" },
      },
    },
    signal,
  );
  const items = records(record(body)?.results);
  return context("notion", [
    `Notion returned ${items.length} recently edited pages and databases.`,
    ...items.slice(0, 15).flatMap((item) => {
      const title = notionTitle(item);
      if (!title) {
        return [];
      }
      const object = stringValue(item.object) ?? "item";
      const propertyNames = Object.keys(record(item.properties) ?? {}).slice(
        0,
        10,
      );
      return [
        `Recently edited ${object}: ${title}${stringValue(item.last_edited_time) ? ` (${stringValue(item.last_edited_time)})` : ""}.`,
        object === "database" && propertyNames.length > 0
          ? `${title} database fields include: ${propertyNames.join(", ")}.`
          : null,
      ];
    }),
  ]);
};

const collectGoogleCalendar: OnboardingContextCollector = async (
  input,
  signal,
) => {
  const token = requiredValue(input.values, "GOOGLE_CALENDAR_TOKEN");
  const body = await providerJson(
    {
      url: queryUrl(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        {
          timeMin: input.now.toISOString(),
          timeMax: daysAfter(input.now, 14).toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "30",
          fields:
            "items(summary,start,end,attendees,recurringEventId,status,description)",
        },
      ),
      token,
    },
    signal,
  );
  const events = records(record(body)?.items).filter((event) => {
    return stringValue(event.status) !== "cancelled";
  });
  const recurring = events.filter((event) => {
    return stringValue(event.recurringEventId) !== null;
  }).length;
  const withoutAgenda = events.filter((event) => {
    return stringValue(event.description) === null;
  }).length;
  const timedEvents = events.flatMap((event) => {
    const start = timestampValue(record(event.start)?.dateTime);
    const end = timestampValue(record(event.end)?.dateTime);
    return start === null || end === null ? [] : [{ start, end }];
  });
  let backToBack = 0;
  for (let index = 1; index < timedEvents.length; index += 1) {
    const previous = timedEvents[index - 1];
    const current = timedEvents[index];
    if (!previous || !current) {
      continue;
    }
    const gap = current.start - previous.end;
    if (gap >= 0 && gap <= 15 * 60 * 1000) {
      backToBack += 1;
    }
  }
  return context("google-calendar", [
    `The next 14 days contain ${events.length} events; ${recurring} are recurring, ${backToBack} start within 15 minutes of the prior meeting, and ${withoutAgenda} have no description or agenda.`,
    ...events.slice(0, 14).map((event) => {
      const summary = stringValue(event.summary) ?? "Untitled event";
      const start = record(event.start);
      const at = stringValue(start?.dateTime) ?? stringValue(start?.date);
      const attendees = records(event.attendees).length;
      return `Upcoming event: ${summary}${at ? ` at ${at}` : ""}; ${attendees} attendee${attendees === 1 ? "" : "s"}.`;
    }),
  ]);
};

const collectOutlookMail: OnboardingContextCollector = async (
  input,
  signal,
) => {
  const token = requiredValue(input.values, "OUTLOOK_MAIL_TOKEN");
  const [inboxBody, messagesBody] = await Promise.all([
    providerJson(
      {
        url: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=totalItemCount,unreadItemCount",
        token,
      },
      signal,
    ),
    providerJson(
      {
        url: "https://graph.microsoft.com/v1.0/me/messages?$top=8&$select=subject,from,isRead,importance&$orderby=receivedDateTime%20desc",
        token,
      },
      signal,
    ),
  ]);
  const inbox = record(inboxBody);
  const messages = records(record(messagesBody)?.value);
  return context("outlook-mail", [
    `Inbox contains ${numberValue(inbox?.totalItemCount) ?? "an unknown number of"} messages, with ${numberValue(inbox?.unreadItemCount) ?? "an unknown number of"} unread.`,
    ...messages.map((message) => {
      const subject = stringValue(message.subject);
      const address = stringValue(
        record(record(message.from)?.emailAddress)?.address,
      );
      const domain = senderDomain(address);
      return subject
        ? `Recent email subject: ${subject}${domain ? ` (from ${domain})` : ""}; ${message.isRead === false ? "unread" : "read"}; importance ${stringValue(message.importance) ?? "normal"}.`
        : null;
    }),
  ]);
};

const collectGoogleAds: OnboardingContextCollector = async (input, signal) => {
  const token = requiredValue(input.values, "GOOGLE_ADS_TOKEN");
  const developerToken = requiredValue(
    input.values,
    "GOOGLE_ADS_DEVELOPER_TOKEN",
  );
  const headers = { "developer-token": developerToken };
  const customersBody = await providerJson(
    {
      url: "https://googleads.googleapis.com/v24/customers:listAccessibleCustomers",
      token,
      headers,
    },
    signal,
  );
  const customerResourceNames = record(customersBody)?.resourceNames;
  const customerIds = Array.isArray(customerResourceNames)
    ? customerResourceNames
        .flatMap((value) => {
          const resource = stringValue(value);
          const id = resource?.match(/^customers\/(\d+)$/u)?.[1];
          return id ? [id] : [];
        })
        .slice(0, 3)
    : [];
  const reports = await Promise.all(
    customerIds.map((customerId) => {
      return providerJson(
        {
          url: `https://googleads.googleapis.com/v24/customers/${encodeURIComponent(customerId)}/googleAds:search`,
          method: "POST",
          token,
          headers,
          body: {
            query:
              "SELECT campaign.name, campaign.status, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC LIMIT 10",
          },
        },
        signal,
      );
    }),
  );
  return context("google-ads", [
    `Google Ads exposes ${customerIds.length} sampled accessible customer account${customerIds.length === 1 ? "" : "s"}.`,
    ...reports.flatMap((report, reportIndex) => {
      return records(record(report)?.results).flatMap((result) => {
        const campaign = record(result.campaign);
        const metrics = record(result.metrics);
        const name = stringValue(campaign?.name);
        if (!name) {
          return [];
        }
        const spendMicros = numberValue(metrics?.costMicros) ?? 0;
        return [
          `Google Ads account ${reportIndex + 1}, campaign ${name}: ${stringValue(campaign?.status) ?? "unknown status"}, ${(spendMicros / 1_000_000).toFixed(2)} spend, ${numberValue(metrics?.clicks) ?? 0} clicks, ${numberValue(metrics?.conversions) ?? 0} conversions in 30 days.`,
        ];
      });
    }),
  ]);
};

const collectMetaAds: OnboardingContextCollector = async (input, signal) => {
  const token = requiredValue(input.values, "META_ADS_TOKEN");
  const headers = { "X-VM0-Connector-Intent": "meta-ads" };
  const accountsBody = await providerJson(
    {
      url: queryUrl("https://graph.facebook.com/v22.0/me/adaccounts", {
        fields: "id,name,account_status,currency,timezone_name",
        limit: "10",
      }),
      token,
      headers,
    },
    signal,
  );
  const accounts = records(record(accountsBody)?.data).slice(0, 3);
  const insights = await Promise.all(
    accounts.flatMap((account) => {
      const id = stringValue(account.id);
      return id
        ? [
            providerJson(
              {
                url: queryUrl(
                  `https://graph.facebook.com/v22.0/${encodeURIComponent(id)}/insights`,
                  {
                    fields: "account_name,spend,impressions,clicks,ctr,cpc",
                    date_preset: "last_30d",
                    level: "account",
                    limit: "1",
                  },
                ),
                token,
                headers,
              },
              signal,
            ),
          ]
        : [];
    }),
  );
  return context("meta-ads", [
    `Meta Ads returned ${accounts.length} sampled ad account${accounts.length === 1 ? "" : "s"}.`,
    ...accounts.map((account) => {
      const name = stringValue(account.name);
      return name
        ? `Ad account: ${name}; status ${numberValue(account.account_status) ?? "unknown"}; currency ${stringValue(account.currency) ?? "unknown"}.`
        : null;
    }),
    ...insights.flatMap((body) => {
      return records(record(body)?.data).map((row) => {
        return `30-day Meta Ads performance for ${stringValue(row.account_name) ?? "an account"}: spend ${stringValue(row.spend) ?? "unknown"}, impressions ${stringValue(row.impressions) ?? "unknown"}, clicks ${stringValue(row.clicks) ?? "unknown"}, CTR ${stringValue(row.ctr) ?? "unknown"}, CPC ${stringValue(row.cpc) ?? "unknown"}.`;
      });
    }),
  ]);
};

/**
 * Exhaustive by construction: adding a source to the onboarding contract must
 * add a fixed, reviewed collector before the API compiles.
 */
export const ONBOARDING_CONTEXT_COLLECTORS = {
  gmail: collectGmail,
  "google-docs": collectGoogleDocs,
  "google-drive": collectGoogleDrive,
  "google-sheets": collectGoogleSheets,
  github: collectGithub,
  quickbooks: collectQuickbooks,
  hubspot: collectHubspot,
  linear: collectLinear,
  notion: collectNotion,
  "google-calendar": collectGoogleCalendar,
  "outlook-mail": collectOutlookMail,
  "google-ads": collectGoogleAds,
  "meta-ads": collectMetaAds,
} satisfies Readonly<
  Record<OnboardingRecommendationConnectorSlug, OnboardingContextCollector>
>;
