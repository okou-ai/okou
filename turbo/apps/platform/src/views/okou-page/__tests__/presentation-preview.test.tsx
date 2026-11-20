import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import {
  openSavedPresentationPicker,
  savedPresentationDraft,
} from "./presentation-draft-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000071";
const PRESENTATION_URL =
  "https://static.vm0.io/vm0/artifact-templates/presentation/daf7c2d1-5195-4c09-ad4b-8d85778fc104/playful-launch-presentation.html";
const TEMPLATE_NAME = "Sunburst playroom";
const PREVIEW_TITLE = `${TEMPLATE_NAME} HTML preview`;

function arrangePresentation(html: string): void {
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      displayName: "Presentation Agent",
    },
  ]);
  context.mocks.http.get(PRESENTATION_URL, () => {
    return HttpResponse.text(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });
}

function namedButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.trim() === name
      );
    }) ?? null
  );
}

function requireNamedButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = namedButton(name, container);
  if (button === null) {
    throw new Error(`Missing button: ${name}`);
  }
  return button;
}

async function waitForNamedButton(
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  await waitFor(() => {
    expect(namedButton(name, container)).not.toBeNull();
  });
  return requireNamedButton(name, container);
}

function activePreviewFrame(): HTMLIFrameElement {
  const frame = screen.getByTitle(PREVIEW_TITLE);
  if (!(frame instanceof HTMLIFrameElement)) {
    throw new Error(`${PREVIEW_TITLE} is not an iframe`);
  }
  return frame;
}

async function openPresentationDetail(
  fromSavedDraft = false,
): Promise<HTMLIFrameElement> {
  if (fromSavedDraft) {
    await openSavedPresentationPicker(TEMPLATE_NAME);
  } else {
    await clickComposerAddMenuItem("Template");
  }
  const preview = await screen.findByLabelText(
    `Preview ${TEMPLATE_NAME} at current slide`,
  );
  const dialog = preview.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Presentation gallery dialog not found");
  }
  click(preview);
  await screen.findByTitle(PREVIEW_TITLE);
  return activePreviewFrame();
}

async function hydratePreviewFrame(
  frame: HTMLIFrameElement,
): Promise<Document> {
  const html = frame.srcdoc;
  const frameDocument = frame.contentDocument;
  if (frameDocument === null) {
    throw new Error("Presentation preview iframe has no document");
  }
  frameDocument.open();
  frameDocument.write(html);
  frameDocument.close();
  fireEvent.load(frame);
  await waitFor(() => {
    expect(frame).toHaveAttribute("data-loaded", "true");
  });
  return frameDocument;
}

function elementBySelector(
  frameDocument: Document,
  selector: string,
): HTMLElement {
  const element = frameDocument.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`Missing presentation element: ${selector}`);
  }
  return element;
}

function computedStyle(element: Element): CSSStyleDeclaration {
  const view = element.ownerDocument.defaultView;
  if (view === null) {
    throw new Error("Presentation preview document has no window");
  }
  return view.getComputedStyle(element);
}

test("Selecting a slide preserves its authored layout", async () => {
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
    return item.embedUrl === PRESENTATION_URL;
  });
  if (!template) {
    throw new Error("Expected the authored presentation template");
  }
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, savedPresentationDraft(template));
  });
  arrangePresentation(`<!doctype html>
    <html>
      <head>
        <style>
          .slide-shell { display: none; }
          .slide-shell.active { display: grid; grid-template-columns: 1fr 2fr; }
          .authored-slide { display: none; }
          .authored-slide.active { display: flex; align-items: center; }
        </style>
      </head>
      <body>
        <div class="slide slide-shell active" aria-hidden="false">
          <section class="authored-slide active" data-okou-slide data-slide-id="slide-one">
            <h1>First slide</h1>
          </section>
        </div>
        <div class="slide slide-shell" hidden inert aria-hidden="true" style="display: none">
          <section class="authored-slide" data-okou-slide data-slide-id="slide-two" hidden inert aria-hidden="true" style="display: none">
            <h1>Selected slide</h1>
          </section>
        </div>
      </body>
    </html>`);
  await setupPage({
    locale: "en-US",
    context,
    host: "app.okou.ai",
    path: `/agents/${AGENT_ID}/chat`,
  });

  const initialFrame = await openPresentationDetail(true);
  const dialog = initialFrame.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Presentation preview dialog not found");
  }
  click(await waitForNamedButton("Preview slide 2", dialog));
  await waitFor(() => {
    expect(activePreviewFrame().srcdoc).toContain("Selected slide");
  });
  const secondFrame = activePreviewFrame();
  const frameDocument = await hydratePreviewFrame(secondFrame);

  expect(frameDocument.querySelector('[data-slide-id="slide-one"]')).toBeNull();
  expect(frameDocument.querySelectorAll("[data-okou-slide]")).toHaveLength(1);
  const wrapper = elementBySelector(frameDocument, ".slide-shell");
  const selectedSlide = elementBySelector(
    frameDocument,
    '[data-slide-id="slide-two"]',
  );
  expect(wrapper).not.toHaveAttribute("hidden");
  expect(wrapper).not.toHaveAttribute("inert");
  expect(wrapper).toHaveAttribute("aria-hidden", "false");
  expect(selectedSlide).not.toHaveAttribute("hidden");
  expect(selectedSlide).not.toHaveAttribute("inert");
  expect(selectedSlide).toHaveAttribute("aria-hidden", "false");
  expect(computedStyle(wrapper).display).toBe("grid");
  expect(computedStyle(selectedSlide).display).toBe("flex");
  expect(requireNamedButton("Preview slide 2", dialog)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("A generically authored deck still previews", async () => {
  arrangePresentation(`<!doctype html>
    <html>
      <body>
        <div data-slide data-slide-id="slide-one">
          <p>Generic first</p>
        </div>
        <div data-slide data-slide-id="slide-two">
          <p>Generic second</p>
        </div>
      </body>
    </html>`);
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/agents/${AGENT_ID}/chat`,
  });

  await openPresentationDetail();
  click(await waitForNamedButton("Preview slide 2"));
  await waitFor(() => {
    expect(activePreviewFrame().srcdoc).toContain("Generic second");
  });
  const frameDocument = await hydratePreviewFrame(activePreviewFrame());

  expect(frameDocument.querySelectorAll("[data-slide]")).toHaveLength(1);
  expect(frameDocument.querySelector('[data-slide-id="slide-one"]')).toBeNull();
  const editable = elementBySelector(frameDocument, "p");
  expect(editable).toHaveTextContent("Generic second");
  expect(editable).toHaveAttribute("data-okou-editor-slide-id", "slide-two");
  expect(editable).toHaveAttribute("data-okou-editor-edit-id");
});
