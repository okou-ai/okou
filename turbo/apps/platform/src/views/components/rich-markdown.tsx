import { withChatScrollLayout } from "./chat-scroll-layout.tsx";
import "../css/vendor/uiw-react-markdown-preview-5.2.0.css";
import { CopyButton } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import type { Element, Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { File, Image, Loader2, Video } from "lucide-react";
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { z } from "zod";

import {
  escapeHtmlTags,
  parseMarkdownTree,
} from "../../lib/markdown/pipeline.ts";
import { openImageLightbox$ } from "../../signals/okou-page/attachment-chips.ts";
import { openMarkdownArtifact$ } from "../../signals/okou-page/markdown-artifact-preview.ts";
import type {
  ArtifactKind,
  ArtifactSignals,
} from "../../signals/chat-page/artifact-card-signals.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import type { AttachmentPreviewSignals } from "../../signals/attachment-resource-url.ts";
import { isImageUrl, isSafeMediaUrl } from "../../lib/media-url.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { MarkdownCardView } from "../okou-page/chat-body-cards.tsx";
import { MarkdownColorPreview } from "./markdown-color-preview.tsx";
import { MarkdownFrame } from "./markdown-frame.tsx";
import { MathFormulaView } from "./math-formula.tsx";
import { MermaidDiagramView } from "./mermaid-diagram.tsx";

type MarkdownNodeProp = { node?: Element };
type MarkdownAnchorProps = ComponentPropsWithoutRef<"a"> & MarkdownNodeProp;
type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & MarkdownNodeProp;
type MarkdownSpanProps = ComponentPropsWithoutRef<"span"> & MarkdownNodeProp;
type MarkdownTimeProps = ComponentPropsWithoutRef<"time"> & MarkdownNodeProp;
type MarkdownDivProps = ComponentPropsWithoutRef<"div"> & {
  node?: Element;
};

/**
 * Wraps a markdown table in an overflow-x-auto container so wide tables scroll
 * within their container instead of stretching the page on mobile.
 */
function ResponsiveTable({ children }: ComponentPropsWithoutRef<"table">) {
  return (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  );
}

function omitMarkdownNodeProp<Props extends object>(
  props: Props,
): Omit<Props, "node"> {
  const cleanProps = { ...props };
  delete (cleanProps as Partial<MarkdownNodeProp>).node;
  return cleanProps;
}

function PlainLink({ href, children, ...rest }: MarkdownAnchorProps) {
  const linkProps = omitMarkdownNodeProp(rest);
  return (
    <a {...linkProps} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function MediaImage({
  src,
  url,
  alt,
  load,
  filename,
  resolvedPreview,
  asLink = false,
  insideLink = false,
}: {
  src: string | undefined;
  url: string;
  alt: string;
  load: ImageLoadSignals;
  filename?: string;
  resolvedPreview?: AttachmentPreviewSignals;
  asLink?: boolean;
  insideLink?: boolean;
}) {
  const imageStatus = useGet(load.status$);
  const markLoaded = useSet(load.loaded$);
  const markFailed = useSet(load.failed$);
  // Self-sourced lightbox handler so MediaImage doesn't need a callback
  // prop chained from the Markdown caller. Removing the `onImageClick`
  // prop chain is what lets the `components` map and the renderer
  // functions live at module scope with stable identity — which in turn
  // prevents React from tearing down the <video>/<img> subtree on every
  // re-render of the parent and refetching media metadata unnecessarily.
  const openImageLightbox = useSet(openImageLightbox$);
  const showPlaceholder = imageStatus !== "loaded";

  const className =
    "my-1 inline-grid aspect-[10/9] w-[200px] max-w-full cursor-pointer grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] align-top overflow-hidden rounded-lg border border-foreground/10 bg-muted/30";
  const preview = (
    <>
      {showPlaceholder && (
        <span
          data-testid="markdown-image-preview-loading"
          className="col-start-1 row-start-1 z-10 flex h-full w-full min-h-0 min-w-0 items-center justify-center bg-muted/70 text-muted-foreground"
        >
          {imageStatus === "loading" ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <Image size={18} />
          )}
        </span>
      )}
      {src !== undefined && (
        <img
          key={src}
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={markLoaded}
          onError={markFailed}
          className={`col-start-1 row-start-1 block h-full w-full min-h-0 min-w-0 object-contain ${
            showPlaceholder ? "opacity-0" : ""
          }`}
        />
      )}
    </>
  );

  if (asLink) {
    // A linked Markdown thumbnail already has its own destination.
    if (insideLink) {
      return <span className={className}>{preview}</span>;
    }
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {preview}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        const threadId = event.currentTarget.closest<HTMLElement>(
          "[data-chat-thread-container-id]",
        )?.dataset.chatThreadContainerId;
        openImageLightbox({
          threadId,
          url,
          filename,
          preview: resolvedPreview,
        });
      }}
      className={className}
    >
      {preview}
    </button>
  );
}

function ArtifactLinkIcon({ kind }: { readonly kind: ArtifactKind }) {
  const iconProps = {
    "aria-hidden": true,
    className: "mr-1 inline-block align-[-0.1em]",
    size: 14,
  };
  if (kind === "image") {
    return (
      <Image {...iconProps} data-testid="markdown-artifact-link-icon-image" />
    );
  }
  if (kind === "video") {
    return (
      <Video {...iconProps} data-testid="markdown-artifact-link-icon-video" />
    );
  }
  return <File {...iconProps} data-testid="markdown-artifact-link-icon-file" />;
}

function MediaLink({ href, children, ...rest }: MarkdownAnchorProps) {
  const openArtifact = useSet(openMarkdownArtifact$);
  const openImageLightbox = useSet(openImageLightbox$);
  const card = rest.node?.data?.card;
  return (
    <PlainLink
      href={href}
      {...rest}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        if (card?.kind === "artifact") {
          event.preventDefault();
          openArtifact(card);
        } else if (href && isSafeMediaUrl(href) && isImageUrl(href)) {
          event.preventDefault();
          const threadId = event.currentTarget.closest<HTMLElement>(
            "[data-chat-thread-container-id]",
          )?.dataset.chatThreadContainerId;
          openImageLightbox(threadId ? { threadId, url: href } : href);
        }
      }}
    >
      {card?.kind === "artifact" && (
        <ArtifactLinkIcon kind={card.signals.kind} />
      )}
      {children}
    </PlainLink>
  );
}

function ArtifactImage({
  signals,
  alt,
}: {
  signals: ArtifactSignals;
  alt: string;
}) {
  const src = useLastResolved(signals.thumbnailUrl$);
  return (
    <MediaImage
      src={src}
      url={signals.url}
      alt={alt}
      load={signals.previewImageLoad}
      filename={signals.filename}
      resolvedPreview={signals}
    />
  );
}

// Module-scope renderers passed into MarkdownPreview's `components` map.
// Function identity is stable across renders, which keeps MarkdownPreview
// from re-mounting the children at <a>/<img> positions on parent re-render.
function PlainLinkRenderer(
  props: { children?: ReactNode } & MarkdownAnchorProps,
) {
  const { children, ...rest } = props;
  return <PlainLink {...rest}>{children}</PlainLink>;
}

function MediaLinkRenderer(
  props: { children?: ReactNode } & MarkdownAnchorProps,
) {
  const { children, ...rest } = props;
  return <MediaLink {...rest}>{children}</MediaLink>;
}

function PlainImageRenderer(props: MarkdownImageProps) {
  const { src, alt, ...rest } = props;
  return <img {...omitMarkdownNodeProp(rest)} src={src} alt={alt} />;
}

function MediaImageRenderer(props: MarkdownImageProps) {
  const { src, alt, ...rest } = props;
  const card = props.node?.data?.card;
  if (card?.kind === "artifact") {
    return card.signals.kind === "image" ? (
      <ArtifactImage signals={card.signals} alt={alt ?? ""} />
    ) : (
      <MarkdownCardView card={card} label={alt} />
    );
  }
  const load = props.node?.data?.imageLoadSignals;
  if (typeof src === "string" && isSafeMediaUrl(src) && load) {
    return <MediaImage src={src} url={src} alt={alt ?? ""} load={load} />;
  }
  return <img {...omitMarkdownNodeProp(rest)} src={src} alt={alt} />;
}

function LinkedMediaImageRenderer(props: MarkdownImageProps) {
  const { src, alt } = props;
  const load = props.node?.data?.imageLoadSignals;
  if (typeof src === "string" && isSafeMediaUrl(src) && load) {
    return (
      <MediaImage
        src={src}
        url={src}
        alt={alt ?? ""}
        load={load}
        asLink
        insideLink={props.node?.data?.imageInsideLink}
      />
    );
  }
  return <PlainImageRenderer {...props} />;
}

function containsBlockArtifact(node: Element): boolean {
  return node.children.some((child) => {
    if (child.type !== "element") {
      return false;
    }
    const card = child.data?.card;
    return (
      (child.tagName === "img" &&
        card?.kind === "artifact" &&
        card.signals.kind !== "image") ||
      containsBlockArtifact(child)
    );
  });
}

function MediaParagraphRenderer({
  children,
  node,
  ...props
}: ComponentPropsWithoutRef<"p"> & MarkdownNodeProp) {
  // Document cards contain block elements, which cannot live inside a <p>.
  if (node && containsBlockArtifact(node)) {
    return (
      <div {...props} className="okou-markdown-card">
        {children}
      </div>
    );
  }
  return <p {...props}>{children}</p>;
}

function MarkdownSpanRenderer(props: MarkdownSpanProps) {
  const math = props.node?.data?.math;
  if (math) {
    return <MathFormulaView formula={math} />;
  }
  const color = props.node?.data?.colorPreview;
  if (typeof color === "string") {
    return <MarkdownColorPreview color={color} />;
  }
  const { children, ...rest } = props;
  return <span {...omitMarkdownNodeProp(rest)}>{children}</span>;
}

const markdownDateTimeSchema = z.iso.datetime({ offset: true });

function MarkdownTimeRenderer({
  children,
  dateTime,
  ...rest
}: MarkdownTimeProps) {
  const features = useLastResolved(featureSwitch$);
  const browserLocales =
    navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  const timestamp = features?.[FeatureSwitchKey.MarkdownTime]
    ? markdownDateTimeSchema.safeParse(dateTime)
    : undefined;
  const content = timestamp?.success
    ? new Intl.DateTimeFormat(browserLocales, {
        dateStyle: "medium",
        timeStyle: "long",
      }).format(new Date(timestamp.data))
    : children;

  return (
    <time {...omitMarkdownNodeProp(rest)} dateTime={dateTime}>
      {content}
    </time>
  );
}

// `rehypeMermaid` turns mermaid fences into `<div data-mermaid-code>`; every
// other div renders as-is.
// The pipeline marks copy buttons and mermaid diagrams on the node's `data`,
// which only it can set — `rehype-raw` produces properties, never data — so a
// message quoting the marker markup renders as the plain div it is.
function MarkdownDivRenderer(props: MarkdownDivProps) {
  const { children, ...rest } = props;
  const data = props.node?.data;
  // A card slot enters the tree as a paragraph and leaves it as this div, so it
  // carries the block spacing the paragraph would have had — without it two
  // consecutive cards sit border-to-border.
  if (data?.card) {
    return (
      <div className="okou-markdown-card">
        <MarkdownCardView card={data.card} />
      </div>
    );
  }
  if (typeof data?.copyCode === "string") {
    return (
      <CopyButton
        type="button"
        text={data.copyCode}
        showTooltip={false}
        className="copied"
        data-code={data.copyCode}
      />
    );
  }
  if (data?.mermaidSignals) {
    return <MermaidDiagramView signals={data.mermaidSignals} />;
  }
  if (data?.math) {
    return <MathFormulaView formula={data.math} />;
  }
  return <div {...omitMarkdownNodeProp(rest)}>{children}</div>;
}

const PLAIN_MARKDOWN_COMPONENTS = {
  table: ResponsiveTable,
  a: PlainLinkRenderer,
  img: PlainImageRenderer,
  span: MarkdownSpanRenderer,
  time: MarkdownTimeRenderer,
  div: MarkdownDivRenderer,
} as const;

const MEDIA_MARKDOWN_COMPONENTS = {
  table: ResponsiveTable,
  p: MediaParagraphRenderer,
  a: MediaLinkRenderer,
  img: MediaImageRenderer,
  span: MarkdownSpanRenderer,
  time: MarkdownTimeRenderer,
  div: MarkdownDivRenderer,
} as const;

const LINKED_MEDIA_MARKDOWN_COMPONENTS = {
  ...PLAIN_MARKDOWN_COMPONENTS,
  img: LinkedMediaImageRenderer,
} as const;

// Neutralize raw HTML by escaping only `<`: a tag cannot start without it, so
// escaping `<` alone stops tag injection. Leaving `>` intact preserves Markdown
// block syntax that relies on a leading `>` — most importantly blockquotes,
// which otherwise collapse into a literal `>` paragraph once escaped.
interface MarkdownTreeFrameProps {
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly mediaPreview?: boolean | "link";
  readonly tree: Root;
}

function MarkdownTreeFrame({
  className,
  style,
  mediaPreview = false,
  tree,
}: MarkdownTreeFrameProps) {
  return withChatScrollLayout(
    <MarkdownFrame className={className} style={style}>
      {toJsxRuntime(tree, {
        Fragment,
        components:
          mediaPreview === "link"
            ? LINKED_MEDIA_MARKDOWN_COMPONENTS
            : mediaPreview
              ? MEDIA_MARKDOWN_COMPONENTS
              : PLAIN_MARKDOWN_COMPONENTS,
        ignoreInvalidStyle: true,
        jsx,
        jsxs,
        passKeys: true,
        passNode: true,
      })}
    </MarkdownFrame>,
  );
}

/**
 * The chat transcript's entry point: renders the tree an event's signal parsed
 * ahead of time, so opening a thread re-renders without re-parsing.
 */
export function MarkdownEventBody({
  className,
  tree,
  mediaPreview,
}: {
  readonly className?: string;
  readonly tree: Root;
  readonly mediaPreview: boolean | "link";
}) {
  return (
    <MarkdownTreeFrame
      className={className}
      tree={tree}
      mediaPreview={mediaPreview}
      style={{ fontSize: "inherit", lineHeight: "inherit" }}
    />
  );
}

/**
 * Parses on render. For one-off documents outside the chat transcript, where
 * there is no signal to hang the parsed tree off.
 */
export function Markdown({
  className,
  style,
  mediaPreview = false,
  escapeHtml = false,
  source,
}: {
  readonly source: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly mediaPreview?: boolean;
  readonly escapeHtml?: boolean;
}) {
  const tree = parseMarkdownTree(
    escapeHtml ? escapeHtmlTags(source) : source,
    {},
  );
  return (
    <MarkdownTreeFrame
      className={className}
      style={style}
      mediaPreview={mediaPreview}
      tree={tree}
    />
  );
}

// The signal layer loads this module as the single rich-content boundary, so
// parsing and rendering arrive together instead of creating a second network
// waterfall after a rich tree has been prepared.
