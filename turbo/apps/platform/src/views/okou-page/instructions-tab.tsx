import type { AgentInstructions } from "../../signals/okou-page/agent-types.ts";
import { useTranslation } from "react-i18next";
import { UnsavedBar } from "./unsaved-bar.tsx";
import { TiptapInstructionsEditor } from "./tiptap-instructions-editor.tsx";
import { InstructionsConflict } from "./instructions-conflict.tsx";

interface InstructionsTabProps {
  instructions: AgentInstructions | null;
  loading: boolean;
  fetchError: string | null;
  editedContent: string | null;
  editorBaseline: string | null;
  editorRevision: number;
  isDirty: boolean;
  isBuilding: boolean;
  isConflict: boolean;
  buildError: string | null;
  onEdit: (value: string) => void;
  onDiscard: () => void;
  onBuild: () => void;
  onReload: () => void;
}

export function InstructionsTab({
  instructions,
  loading,
  fetchError,
  editedContent,
  editorBaseline,
  editorRevision,
  isDirty,
  isBuilding,
  isConflict,
  buildError,
  onEdit,
  onDiscard,
  onBuild,
  onReload,
}: InstructionsTabProps) {
  const { t } = useTranslation("agents");
  const rawContent = instructions?.content ?? "";
  const displayContent = editedContent ?? rawContent;

  // Discard must reset the document, undo history, and focus even though the
  // saved content has not changed. Keep the key stable while the user types.
  const editorKey = `${editorRevision}:${editorBaseline ?? rawContent}`;

  return (
    <div className="mx-auto max-w-[900px]">
      {loading ? (
        <div className="space-y-4 animate-pulse">
          <div className="h-5 w-40 rounded bg-muted/50" />
          <div className="h-64 w-full rounded bg-muted/30" />
        </div>
      ) : fetchError ? (
        <p className="text-sm text-destructive">{fetchError}</p>
      ) : (
        <>
          <TiptapInstructionsEditor
            key={editorKey}
            initialContent={displayContent}
            onChange={onEdit}
            disabled={isBuilding}
            ariaLabel={t(($) => {
              return $.instructions.editor.accessibilityLabel;
            })}
            placeholder={t(($) => {
              return $.instructions.editor.placeholder;
            })}
            footerHint={t(($) => {
              return $.instructions.editor.footerHint;
            })}
            toolbarLabels={{
              bold: t(($) => {
                return $.instructions.editor.toolbar.bold;
              }),
              italic: t(($) => {
                return $.instructions.editor.toolbar.italic;
              }),
              strikethrough: t(($) => {
                return $.instructions.editor.toolbar.strikethrough;
              }),
              inlineCode: t(($) => {
                return $.instructions.editor.toolbar.inlineCode;
              }),
              heading1: t(($) => {
                return $.instructions.editor.toolbar.heading1;
              }),
              heading2: t(($) => {
                return $.instructions.editor.toolbar.heading2;
              }),
              heading3: t(($) => {
                return $.instructions.editor.toolbar.heading3;
              }),
              bulletList: t(($) => {
                return $.instructions.editor.toolbar.bulletList;
              }),
              orderedList: t(($) => {
                return $.instructions.editor.toolbar.orderedList;
              }),
              blockquote: t(($) => {
                return $.instructions.editor.toolbar.blockquote;
              }),
            }}
          />
          {buildError && (
            <p className="text-xs font-medium text-destructive mt-3">
              {buildError}
            </p>
          )}
          {isConflict && (
            <InstructionsConflict loading={isBuilding} onReload={onReload} />
          )}
        </>
      )}

      {(isDirty || isBuilding) && (
        <UnsavedBar
          onDiscard={onDiscard}
          onSave={onBuild}
          saving={isBuilding}
          saveDisabled={isConflict}
          message={t(($) => {
            return $.unsaved.message;
          })}
          discardLabel={t(($) => {
            return $.actions.discard;
          })}
          saveLabel={t(($) => {
            return $.actions.save;
          })}
        />
      )}
    </div>
  );
}
