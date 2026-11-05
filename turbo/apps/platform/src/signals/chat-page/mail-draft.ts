import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { mailContract } from "@okouai/api-contracts/client/mail";
import type {
  MailAttachment,
  MailDraft,
  MailDraftStatus,
  MailInlineImage,
} from "@okouai/api-contracts/contracts/mail";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import { onRef } from "../utils.ts";
import {
  createTextPreviewComputedFromBlob,
  type TextPreviewComputed,
} from "../text-preview.ts";
import { parseTrustedPlatformUrl } from "./trusted-platform-url.ts";
import { isConnectorChangedPayloadFor } from "../connector-change.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";

export interface MailDraftDescriptor {
  readonly mailDraftId: string;
  readonly originalUrl: string;
  readonly href: string;
}

interface MailAttachmentPartPreview {
  readonly attachment: MailAttachment;
  /** Object URL of the fetched part; null when the part no longer exists. */
  readonly url: string | null;
  readonly text$: TextPreviewComputed | undefined;
}

export interface MailInlineImagePreview {
  readonly image: MailInlineImage;
  /** Object URL of the fetched part; null when the part no longer exists. */
  readonly url: string | null;
}

/**
 * Fetched part previews joined onto the draft's own attachment and inline
 * image lists. The part lookup happens here, so the sidebar walks these lists
 * directly instead of resolving parts by id while rendering.
 */
export interface MailAttachmentPreviews {
  readonly attachments: readonly MailAttachmentPartPreview[];
  readonly inlineImages: readonly MailInlineImagePreview[];
}

/** The connectors a mail draft can be waiting for. */
const MAIL_CONNECTOR_SLUGS = ["gmail", "outlook-mail"] as const;

export interface MailDraftSignals extends MailDraftDescriptor {
  /** Present only when the mail is displayed inside a chat. */
  readonly threadId: string | undefined;
  readonly draft$: Computed<Promise<MailDraft | null>>;
  readonly sidebarDraft$: Computed<Promise<MailDraft | null>>;
  readonly attachmentPreviews$: Computed<Promise<MailAttachmentPreviews>>;
  readonly setAttachmentScopeRef$: Command<
    (() => void) | undefined,
    [HTMLDivElement | null]
  >;
  readonly reloadDraft$: Command<void, []>;
  /**
   * Re-reads the draft whenever a mail connector changes, for example after
   * the member reconnects the account a draft was waiting for.
   */
  readonly subscribeConnectorChanges$: Command<void, [AbortSignal]>;
  readonly delete$: Command<Promise<void>, [AbortSignal]>;
  readonly send$: Command<Promise<MailDraftStatus>, [AbortSignal]>;
}

export type MailDraftCardSignalsRegistry = CardSignalsRegistry<
  MailDraftDescriptor,
  MailDraftSignals
>;

export function parseMailDraftUrl(value: string): MailDraftDescriptor | null {
  const url = parseTrustedPlatformUrl(value);
  if (!url) {
    return null;
  }
  const match = url.pathname.match(
    /^\/mail\/drafts\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/iu,
  );
  const mailDraftId = match?.[1];
  if (!mailDraftId) {
    return null;
  }
  return {
    mailDraftId,
    originalUrl: value,
    href: `/mail/drafts/${mailDraftId}`,
  };
}

function createAttachmentPreviews(
  descriptor: MailDraftDescriptor,
  sidebarDraft$: Computed<Promise<MailDraft | null>>,
): Pick<MailDraftSignals, "attachmentPreviews$" | "setAttachmentScopeRef$"> {
  const attachmentObjectUrls = new Map<string, string>();
  const attachmentScopeActive$ = state(false);
  let loadVersion = 0;
  const revokeAttachmentObjectUrls = () => {
    for (const url of attachmentObjectUrls.values()) {
      URL.revokeObjectURL(url);
    }
    attachmentObjectUrls.clear();
  };
  const releaseAttachmentObjectUrls = () => {
    loadVersion += 1;
    revokeAttachmentObjectUrls();
  };
  const attachmentPreviews$ = computed(
    async (get): Promise<MailAttachmentPreviews> => {
      if (!get(attachmentScopeActive$)) {
        return { attachments: [], inlineImages: [] };
      }
      const currentLoadVersion = ++loadVersion;
      const draftPromise = get(sidebarDraft$);
      const client = get(apiClient$)(mailContract);
      const draft = await draftPromise;
      if (currentLoadVersion !== loadVersion) {
        return { attachments: [], inlineImages: [] };
      }
      const attachments = draft?.version === 3 ? draft.attachments : [];
      const attachmentPartIds = new Set(
        attachments.flatMap((attachment) => {
          return attachment.partId ? [attachment.partId] : [];
        }),
      );
      const partIds = Array.from(
        new Set([
          ...(draft?.inlineImages ?? []).map((image) => {
            return image.partId;
          }),
          ...attachmentPartIds,
        ]),
      );
      const responses = await Promise.all(
        partIds.map(async (partId) => {
          const response = await accept(
            client.getAttachment({
              params: {
                mailDraftId: descriptor.mailDraftId,
                partId,
              },
            }),
            [200, 404],
          );
          return { partId, response };
        }),
      );
      if (currentLoadVersion !== loadVersion) {
        return { attachments: [], inlineImages: [] };
      }
      revokeAttachmentObjectUrls();
      const urlByPartId = new Map<string, string | null>();
      const textByPartId = new Map<string, TextPreviewComputed>();
      for (const { partId, response } of responses) {
        if (response.status === 404) {
          urlByPartId.set(partId, null);
          continue;
        }
        const url = URL.createObjectURL(response.body);
        attachmentObjectUrls.set(partId, url);
        urlByPartId.set(partId, url);
        if (attachmentPartIds.has(partId)) {
          textByPartId.set(
            partId,
            createTextPreviewComputedFromBlob(response.body),
          );
        }
      }
      return {
        attachments: attachments.map((attachment) => {
          const partId = attachment.partId;
          return {
            attachment,
            url: partId ? (urlByPartId.get(partId) ?? null) : null,
            text$: partId ? textByPartId.get(partId) : undefined,
          };
        }),
        inlineImages: (draft?.inlineImages ?? []).map((image) => {
          return { image, url: urlByPartId.get(image.partId) ?? null };
        }),
      };
    },
  );
  const setAttachmentScopeRef$ = onRef(
    command(({ set }, _element: HTMLDivElement, signal: AbortSignal) => {
      set(attachmentScopeActive$, true);
      signal.addEventListener(
        "abort",
        () => {
          releaseAttachmentObjectUrls();
          set(attachmentScopeActive$, false);
        },
        { once: true },
      );
    }),
  );
  return {
    attachmentPreviews$,
    setAttachmentScopeRef$,
  };
}

interface MailDraftResourceSignals extends Pick<
  MailDraftSignals,
  "draft$" | "sidebarDraft$" | "reloadDraft$" | "subscribeConnectorChanges$"
> {
  readonly draftOverride$: State<MailDraft | null | undefined>;
}

function createMailDraftResourceSignals(
  descriptor: MailDraftDescriptor,
): MailDraftResourceSignals {
  const draftOverride$ = state<MailDraft | null | undefined>(undefined);
  const draftReloadVersion$ = state(0);
  const draft$ = computed(async (get): Promise<MailDraft | null> => {
    get(draftReloadVersion$);
    const override = get(draftOverride$);
    if (override !== undefined) {
      return override;
    }
    const response = await accept(
      get(apiClient$)(mailContract).getDraft({
        params: { mailDraftId: descriptor.mailDraftId },
      }),
      [200, 404],
    );
    return response.status === 200 ? response.body.mailDraft : null;
  });
  const sidebarDraft$ = draft$;
  const reloadDraft$ = command(({ set }) => {
    set(draftOverride$, undefined);
    set(draftReloadVersion$, (version) => {
      return version + 1;
    });
  });
  const reloadOnConnectorChange$ = command(
    ({ set }, payload: unknown): boolean => {
      if (
        MAIL_CONNECTOR_SLUGS.some((connectorSlug) => {
          return isConnectorChangedPayloadFor(payload, connectorSlug);
        })
      ) {
        set(reloadDraft$);
      }
      return false;
    },
  );
  const reloadAfterResync$ = command(({ set }): boolean => {
    set(reloadDraft$);
    return false;
  });
  const subscribeConnectorChanges$ = command(({ set }, signal: AbortSignal) => {
    set(
      setAblyPayloadLoop$,
      {
        topic: "connector:changed",
        loopCommand$: reloadOnConnectorChange$,
        initializeCommand$: reloadAfterResync$,
        // The draft is read when the card renders; only a continuity gap
        // needs another read.
        options: { runOnSubscribe: false },
      },
      signal,
    );
  });
  return {
    draftOverride$,
    draft$,
    sidebarDraft$,
    reloadDraft$,
    subscribeConnectorChanges$,
  };
}

function createMailDraftMutationSignals(
  descriptor: MailDraftDescriptor,
  resources: MailDraftResourceSignals,
): Pick<MailDraftSignals, "delete$" | "send$"> {
  const delete$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      await accept(
        get(apiClient$)(mailContract).deleteDraft({
          params: { mailDraftId: descriptor.mailDraftId },
          fetchOptions: { signal },
        }),
        [204],
      );
      signal.throwIfAborted();
      set(resources.draftOverride$, null);
    },
  );
  const send$ = command(async ({ get, set }, signal: AbortSignal) => {
    const response = await accept(
      get(apiClient$)(mailContract).sendDraft({
        params: { mailDraftId: descriptor.mailDraftId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(resources.draftOverride$, response.body.mailDraft);
    return response.body.mailDraft.status;
  });
  return { delete$, send$ };
}

export function createMailDraftSignals(
  descriptor: MailDraftDescriptor,
  threadId?: string,
): MailDraftSignals {
  const resources = createMailDraftResourceSignals(descriptor);
  const mutations = createMailDraftMutationSignals(descriptor, resources);
  const attachmentPreviews = createAttachmentPreviews(
    descriptor,
    resources.sidebarDraft$,
  );
  return {
    mailDraftId: descriptor.mailDraftId,
    originalUrl: descriptor.originalUrl,
    href: descriptor.href,
    threadId,
    draft$: resources.draft$,
    sidebarDraft$: resources.sidebarDraft$,
    ...attachmentPreviews,
    reloadDraft$: resources.reloadDraft$,
    subscribeConnectorChanges$: resources.subscribeConnectorChanges$,
    delete$: mutations.delete$,
    send$: mutations.send$,
  };
}

export function createMailDraftCardSignalsRegistry(
  threadId: string,
): MailDraftCardSignalsRegistry {
  return createCardSignalsRegistry(
    (descriptor: MailDraftDescriptor) => {
      return descriptor.mailDraftId;
    },
    (descriptor) => {
      return createMailDraftSignals(descriptor, threadId);
    },
    (signals) => {
      return signals.subscribeConnectorChanges$;
    },
  );
}
