import { command } from "ccstate";
import type { WorkflowFileEntry } from "@okouai/api-contracts/contracts/workflows";

import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import {
  copyWorkflow$,
  deleteWorkflow$,
  pauseWorkflowAutomations$,
  runWorkflowAutomationNow$,
  setSelectedWorkflowFilePath$,
  setWorkflowActionDialog$,
  setWorkflowFileDraft$,
  updateWorkflow$,
} from "./workflows-signals.ts";

export const copyOrMoveWorkflow$ = command(
  async (
    { set },
    input: {
      readonly workflowId: string;
      readonly toAgentId: string;
      readonly removeOriginal: boolean;
      readonly enabledSourceAutomationIds: readonly string[];
    },
    signal: AbortSignal,
  ) => {
    const copied = await set(
      copyWorkflow$,
      { workflowId: input.workflowId, toAgentId: input.toAgentId },
      signal,
    );
    if (input.removeOriginal) {
      await set(
        pauseWorkflowAutomations$,
        input.enabledSourceAutomationIds,
        signal,
      );
      await set(deleteWorkflow$, input.workflowId, signal);
    }
    set(setWorkflowActionDialog$, null);
    if (input.removeOriginal) {
      set(detachedNavigateTo$, ROUTES.workflowDetailAutomations, {
        pathParams: { workflowId: copied.id },
      });
    }
    // Navigation may abort the page owner. Return the committed result so the
    // view can still present its success toast and browser navigation callback.
    return { copied, removedOriginal: input.removeOriginal };
  },
);

export const deleteWorkflowAndReturnToList$ = command(
  async ({ set }, workflowId: string, signal: AbortSignal) => {
    await set(deleteWorkflow$, workflowId, signal);
    set(setWorkflowActionDialog$, null);
    set(detachedNavigateTo$, ROUTES.workflows);
  },
);

export const uploadWorkflowFiles$ = command(
  async (
    { set },
    input: {
      readonly workflowId: string;
      readonly fileContents: readonly WorkflowFileEntry[];
      readonly files: readonly File[];
    },
    signal: AbortSignal,
  ) => {
    const uploaded = await Promise.all(
      input.files.map(async (file) => {
        const path = (file.webkitRelativePath || file.name).replace(
          /^\.\//,
          "",
        );
        return { path, content: await file.text() };
      }),
    );
    // File.text() is browser-owned and cannot receive the page signal.
    signal.throwIfAborted();
    const byPath = new Map(
      input.fileContents.map((file) => {
        return [file.path, file];
      }),
    );
    for (const file of uploaded) {
      byPath.set(file.path, file);
    }
    await set(
      updateWorkflow$,
      { workflowId: input.workflowId, body: { files: [...byPath.values()] } },
      signal,
    );
    set(setSelectedWorkflowFilePath$, uploaded[0]?.path ?? null);
  },
);

export const deleteWorkflowFile$ = command(
  async (
    { set },
    input: {
      readonly workflowId: string;
      readonly fileContents: readonly WorkflowFileEntry[];
      readonly filePath: string;
    },
    signal: AbortSignal,
  ) => {
    await set(
      updateWorkflow$,
      {
        workflowId: input.workflowId,
        body: {
          files: input.fileContents.filter((file) => {
            return file.path !== input.filePath;
          }),
        },
      },
      signal,
    );
    set(setSelectedWorkflowFilePath$, null);
  },
);

export const saveWorkflowFileDraft$ = command(
  async (
    { set },
    input: {
      readonly workflowId: string;
      readonly fileContents: readonly WorkflowFileEntry[];
      readonly filePath: string | null;
      readonly content: string;
    },
    signal: AbortSignal,
  ) => {
    const body = input.filePath
      ? {
          files: input.fileContents.map((file) => {
            return file.path === input.filePath
              ? { path: file.path, content: input.content }
              : file;
          }),
        }
      : { instruction: input.content || null };
    await set(updateWorkflow$, { workflowId: input.workflowId, body }, signal);
    set(setWorkflowFileDraft$, null);
  },
);

export const runWorkflowAutomationAndOpenThread$ = command(
  async ({ set }, automationId: string, signal: AbortSignal) => {
    const result = await set(runWorkflowAutomationNow$, automationId, signal);
    signal.throwIfAborted();
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId: result.chatThreadId },
    });
  },
);
