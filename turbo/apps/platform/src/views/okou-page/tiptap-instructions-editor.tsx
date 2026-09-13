// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import { Extension } from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";
import { Bold as BoldExtension } from "@tiptap/extension-bold";
import { Code as CodeExtension } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Heading } from "@tiptap/extension-heading";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { Italic as ItalicExtension } from "@tiptap/extension-italic";
import {
  BulletList,
  ListItem,
  ListKeymap,
  OrderedList,
} from "@tiptap/extension-list";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Strike } from "@tiptap/extension-strike";
import { Text } from "@tiptap/extension-text";
import { Underline } from "@tiptap/extension-underline";
import {
  Dropcursor,
  Gapcursor,
  TrailingNode,
  UndoRedo,
} from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code,
} from "lucide-react";
import { surfaceVariants, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";

interface TiptapInstructionsEditorProps {
  initialContent: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  /** Hint shown below the editor (default copy is for agent profile instructions). */
  footerHint?: string | null;
  /** Visual surface for embedding the editor in either a card or a full-page canvas. */
  surface?: "card" | "canvas";
  toolbarLabels?: Partial<ToolbarLabels>;
}

const ICON_SIZE = 18;
interface ToolbarLabels {
  bold: string;
  italic: string;
  strikethrough: string;
  inlineCode: string;
  heading1: string;
  heading2: string;
  heading3: string;
  bulletList: string;
  orderedList: string;
  blockquote: string;
}

function ToolbarButton({
  onAction,
  active,
  disabled,
  title,
  children,
}: {
  onAction: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        onAction();
      }}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center rounded p-1.5 text-popover-foreground/70 transition-colors hover:bg-state-hover hover:text-popover-foreground disabled:opacity-40 disabled:pointer-events-none ${active ? "bg-accent text-popover-foreground" : ""}`}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="mx-0.5 h-4 w-px bg-divider" />;
}

const EDITOR_CLASSES =
  "max-w-none px-4 py-3 min-h-[200px] outline-none " +
  "text-sm text-foreground leading-relaxed font-[var(--font-family-sans)] " +
  "[&_p]:my-2 " +
  "[&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4 " +
  "[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:my-3 " +
  "[&_h3]:text-lg [&_h3]:font-medium [&_h3]:my-2 " +
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-0.5 " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:my-2 [&_blockquote]:text-muted-foreground " +
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[13px] [&_code]:font-[var(--font-family-mono)] " +
  "[&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:my-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_hr]:border-border [&_hr]:my-4";

function createInstructionsEditorExtensions() {
  return [
    BoldExtension,
    Blockquote,
    BulletList,
    CodeExtension,
    CodeBlock,
    Document,
    Dropcursor,
    Gapcursor,
    HardBreak,
    Heading,
    UndoRedo,
    HorizontalRule,
    ItalicExtension,
    ListItem,
    ListKeymap,
    OrderedList,
    Paragraph,
    Strike,
    Text,
    Underline,
    TrailingNode,
    Markdown,
  ];
}

/**
 * Tiptap extension that captures the markdown the editor produces right after
 * parsing the initial content.  This "baseline" lets onUpdate distinguish
 * Tiptap's own round-trip normalisation from genuine user edits.
 */
function createBaselineExtension(onChange: (markdown: string) => void) {
  return Extension.create<Record<string, never>, { baseline: string | null }>({
    name: "baselineMarkdown",
    addStorage() {
      return { baseline: null };
    },
    onCreate() {
      this.storage.baseline = this.editor.getMarkdown();
    },
    onUpdate() {
      const md = this.editor.getMarkdown();
      if (md === this.storage.baseline) {
        return;
      }
      onChange(md);
    },
  });
}

export function TiptapInstructionsEditor({
  initialContent,
  onChange,
  disabled = false,
  ariaLabel,
  placeholder,
  footerHint,
  surface = "card",
  toolbarLabels,
}: TiptapInstructionsEditorProps) {
  const { t } = useTranslation();
  const labels: ToolbarLabels = {
    bold: t(($) => {
      return $.workflows.editor.toolbar.bold;
    }),
    italic: t(($) => {
      return $.workflows.editor.toolbar.italic;
    }),
    strikethrough: t(($) => {
      return $.workflows.editor.toolbar.strikethrough;
    }),
    inlineCode: t(($) => {
      return $.workflows.editor.toolbar.inlineCode;
    }),
    heading1: t(($) => {
      return $.workflows.editor.toolbar.heading1;
    }),
    heading2: t(($) => {
      return $.workflows.editor.toolbar.heading2;
    }),
    heading3: t(($) => {
      return $.workflows.editor.toolbar.heading3;
    }),
    bulletList: t(($) => {
      return $.workflows.editor.toolbar.bulletList;
    }),
    orderedList: t(($) => {
      return $.workflows.editor.toolbar.orderedList;
    }),
    blockquote: t(($) => {
      return $.workflows.editor.toolbar.blockquote;
    }),
    ...toolbarLabels,
  };
  const resolvedAriaLabel =
    ariaLabel ??
    t(($) => {
      return $.workflows.editor.aria;
    });
  const resolvedPlaceholder =
    placeholder ??
    t(($) => {
      return $.workflows.editor.placeholder;
    });
  const resolvedFooterHint =
    footerHint === undefined
      ? t(($) => {
          return $.workflows.editor.footer;
        })
      : footerHint;
  const editorClassName = cn(
    EDITOR_CLASSES,
    surface === "canvas" ? "min-h-[calc(100vh-10rem)] px-0 py-3" : "",
  );
  const editor = useEditor({
    extensions: [
      ...createInstructionsEditorExtensions(),
      createBaselineExtension(onChange),
    ],
    content: initialContent,
    contentType: "markdown",
    editable: !disabled,
    editorProps: {
      attributes: {
        class: editorClassName,
        "aria-label": resolvedAriaLabel,
        "data-placeholder": resolvedPlaceholder,
      },
    },
  });

  return (
    <div
      className={cn(
        "relative transition-colors",
        surface === "card" ? surfaceVariants() : "",
        disabled ? "pointer-events-none opacity-60" : "",
      )}
    >
      {editor && (
        <BubbleMenu
          editor={editor}
          updateDelay={0}
          className="z-50 flex items-center gap-1 rounded-lg okou-border bg-popover px-1.5 py-1 shadow-lg"
        >
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleBold().run();
            }}
            active={editor.isActive("bold")}
            disabled={disabled}
            title={labels.bold}
          >
            <Bold size={ICON_SIZE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleItalic().run();
            }}
            active={editor.isActive("italic")}
            disabled={disabled}
            title={labels.italic}
          >
            <Italic size={ICON_SIZE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleStrike().run();
            }}
            active={editor.isActive("strike")}
            disabled={disabled}
            title={labels.strikethrough}
          >
            <Strikethrough size={ICON_SIZE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleCode().run();
            }}
            active={editor.isActive("code")}
            disabled={disabled}
            title={labels.inlineCode}
          >
            <Code size={ICON_SIZE} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleHeading({ level: 1 }).run();
            }}
            active={editor.isActive("heading", { level: 1 })}
            disabled={disabled}
            title={labels.heading1}
          >
            <Heading1 size={ICON_SIZE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleHeading({ level: 2 }).run();
            }}
            active={editor.isActive("heading", { level: 2 })}
            disabled={disabled}
            title={labels.heading2}
          >
            <Heading2 size={ICON_SIZE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleHeading({ level: 3 }).run();
            }}
            active={editor.isActive("heading", { level: 3 })}
            disabled={disabled}
            title={labels.heading3}
          >
            <Heading3 size={ICON_SIZE} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleBulletList().run();
            }}
            active={editor.isActive("bulletList")}
            disabled={disabled}
            title={labels.bulletList}
          >
            <List size={ICON_SIZE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleOrderedList().run();
            }}
            active={editor.isActive("orderedList")}
            disabled={disabled}
            title={labels.orderedList}
          >
            <ListOrdered size={ICON_SIZE} />
          </ToolbarButton>
          <ToolbarButton
            onAction={() => {
              return editor.chain().focus().toggleBlockquote().run();
            }}
            active={editor.isActive("blockquote")}
            disabled={disabled}
            title={labels.blockquote}
          >
            <Quote size={ICON_SIZE} />
          </ToolbarButton>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      {resolvedFooterHint ? (
        <p className="mx-4 border-t border-t-gray-400 pt-2 pb-3 text-xs text-muted-foreground">
          {resolvedFooterHint}
        </p>
      ) : null}
    </div>
  );
}
