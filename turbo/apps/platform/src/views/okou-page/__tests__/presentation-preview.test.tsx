import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000071";
const PRESENTATION_URL =
  "https://static.vm0.io/vm0/artifact-templates/presentation/daf7c2d1-5195-4c09-ad4b-8d85778fc104/playful-launch-presentation.html";
const TEMPLATE_NAME = "Sunburst playroom";
const PREVIEW_TITLE = `${TEMPLATE_NAME} HTML preview`;

interface PresentationObjectUrls {
  readonly htmlFor: (frame: HTMLIFrameElement) => Promise<string>;
}

function installPresentationObjectUrls(): PresentationObjectUrls {
  const sources = new Map<string, Blob>();
  let nextObjectUrl = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation((source) => {
    if (!(source instanceof Blob)) {
      throw new Error("Presentation preview created a non-Blob object URL");
    }
    nextObjectUrl += 1;
    const url = `blob:https://app.okou.ai/presentation-preview-${String(nextObjectUrl)}`;
    sources.set(url, source);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

  return {
    htmlFor(frame) {
      const url = frame.getAttribute("src");
      const source = url === null ? undefined : sources.get(url);
      if (source === undefined) {
        throw new Error(`No captured presentation document for ${url ?? ""}`);
      }
      return source.text();
    },
  };
}

function arrangePresentation(html: string): PresentationObjectUrls {
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
  return installPresentationObjectUrls();
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

async function openPresentationDetail(): Promise<HTMLIFrameElement> {
  click(await waitForNamedButton("Template"));
  const dialog = await screen.findByRole("dialog");
  click(
    await waitForNamedButton(
      `Preview ${TEMPLATE_NAME} at current slide`,
      dialog,
    ),
  );
  await screen.findByTitle(PREVIEW_TITLE);
  return activePreviewFrame();
}

async function hydratePreviewFrame(
  frame: HTMLIFrameElement,
  objectUrls: PresentationObjectUrls,
): Promise<Document> {
  const html = await objectUrls.htmlFor(frame);
  frame.removeAttribute("src");
  frame.srcdoc = html;
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

async function openReadyPresentation(
  objectUrls: PresentationObjectUrls,
): Promise<{ readonly document: Document; readonly frame: HTMLIFrameElement }> {
  const frame = await openPresentationDetail();
  return { document: await hydratePreviewFrame(frame, objectUrls), frame };
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

function expectCssColor(actual: string, expected: readonly string[]): void {
  expect(expected).toContain(actual.toLowerCase().replaceAll(", ", ","));
}

test("Selecting a slide preserves its authored layout", async () => {
  const objectUrls = arrangePresentation(`<!doctype html>
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

  const firstFrame = await openPresentationDetail();
  // Selection depends on the iframe load event, not on reading the first
  // slide's document. Render and inspect the selected slide below.
  fireEvent.load(firstFrame);
  await waitFor(() => {
    expect(firstFrame).toHaveAttribute("data-loaded", "true");
  });
  const firstFrameUrl = firstFrame.getAttribute("src");
  click(await waitForNamedButton("Preview slide 2"));
  await waitFor(() => {
    expect(activePreviewFrame().getAttribute("src")).not.toBe(firstFrameUrl);
  });
  const secondFrame = activePreviewFrame();
  const frameDocument = await hydratePreviewFrame(secondFrame, objectUrls);

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
  expect(requireNamedButton("Preview slide 2")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("A generically authored deck still previews", async () => {
  const objectUrls = arrangePresentation(`<!doctype html>
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

  const firstFrame = await openPresentationDetail();
  await hydratePreviewFrame(firstFrame, objectUrls);
  const firstFrameUrl = firstFrame.getAttribute("src");
  click(await waitForNamedButton("Preview slide 2"));
  await waitFor(() => {
    expect(activePreviewFrame().getAttribute("src")).not.toBe(firstFrameUrl);
  });
  const frameDocument = await hydratePreviewFrame(
    activePreviewFrame(),
    objectUrls,
  );

  expect(frameDocument.querySelectorAll("[data-slide]")).toHaveLength(1);
  expect(frameDocument.querySelector('[data-slide-id="slide-one"]')).toBeNull();
  const editable = elementBySelector(frameDocument, "p");
  expect(editable).toHaveTextContent("Generic second");
  expect(editable).toHaveAttribute("data-okou-editor-slide-id", "slide-two");
  expect(editable).toHaveAttribute("data-okou-editor-edit-id");
});

test("A presentation slide fills its preview frame cleanly", async () => {
  const objectUrls = arrangePresentation(`<!doctype html>
    <html>
      <body>
        <section data-okou-slide data-slide-id="slide-one" style="width: 100vw; height: 100vh; border-radius: 32px; box-shadow: 0 20px 60px #0008">
          <div class="stage" style="width: 100vw; height: 100vh; max-width: 1440px; max-height: 810px; border-radius: 24px; box-shadow: 0 12px 40px #0006">
            <h1>Nested stage</h1>
          </div>
        </section>
      </body>
    </html>`);
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/agents/${AGENT_ID}/chat`,
  });

  const { document: frameDocument } = await openReadyPresentation(objectUrls);
  const slide = elementBySelector(frameDocument, "[data-okou-slide]");
  const stage = elementBySelector(frameDocument, ".stage");
  const slideStyle = computedStyle(slide);
  const stageStyle = computedStyle(stage);

  expect(slideStyle.width).toBe("100%");
  expect(slideStyle.height).toBe("100%");
  expect(slideStyle.boxShadow).toBe("none");
  expect(["0", "0px"]).toContain(slideStyle.borderRadius);
  expect(stageStyle.width).toBe("100%");
  expect(stageStyle.height).toBe("100%");
  expect(stageStyle.maxWidth).toBe("none");
  expect(stageStyle.maxHeight).toBe("none");
  expect(stageStyle.boxShadow).toBe("none");
  expect(["0", "0px"]).toContain(stageStyle.borderRadius);
});

test("An unusable generated theme does not break the presentation preview", async () => {
  const objectUrls = arrangePresentation(`<!doctype html>
    <html>
      <body>
        <section data-okou-slide data-slide-id="slide-one" style="background-color: #fef3c7; color: #1f2937">
          <h1>Authored fallback remains</h1>
        </section>
        <script>
          var MONO={"Safe":["#fffdf7","#ffffff","#221c14","#5e564a","#efeADF",["#ff7a1a","#e5388e","#f5b73e","#1fb6a6"]]};
          var VIB={};
          var FONTS={"Studio":["Fraunces","Inter"]};
          var swPal=document.getElementById("swPal");
          var swFont=document.getElementById("swFont");
          swPal.value="M:Missing";
          swFont.value="Missing";
          setPalette(swPal.value);
          setFont(swFont.value);
        </script>
      </body>
    </html>`);
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/agents/${AGENT_ID}/chat`,
  });

  const { document: frameDocument, frame } =
    await openReadyPresentation(objectUrls);
  const slide = elementBySelector(frameDocument, "[data-okou-slide]");
  const slideStyle = computedStyle(slide);

  expect(frame).toHaveAttribute("data-loaded", "true");
  expect(slide).toHaveTextContent("Authored fallback remains");
  expectCssColor(slideStyle.backgroundColor, ["#fef3c7", "rgb(254,243,199)"]);
  expectCssColor(slideStyle.color, ["#1f2937", "rgb(31,41,55)"]);
  expect(frameDocument.querySelector("script")).toBeNull();
  expect(
    frameDocument.querySelector('[data-okou-materialized-theme="true"]'),
  ).toBeNull();
});

test("Presentation previews preserve the selected theme", async () => {
  const objectUrls = arrangePresentation(`<!doctype html>
    <html>
      <head>
        <style>
          .themed-slide { background: var(--bg); color: var(--ink); font-family: var(--fb); }
        </style>
      </head>
      <body>
        <section class="themed-slide" data-okou-slide data-slide-id="slide-one">
          <h1>Selected generated theme</h1>
        </section>
        <script>
          var MONO={"Funfair":["#FFFDF7","#FFFFFF","#221C14","#5E564A","#EFEADF",["#FF7A1A","#E5388E","#F5B73E","#1FB6A6"]]};
          var VIB={};
          var FONTS={"Studio":["Fraunces","Inter"]};
          var swPal=document.getElementById("swPal");
          var swFont=document.getElementById("swFont");
          swPal.value="M:Funfair";
          swFont.value="Studio";
          setPalette(swPal.value);
          setFont(swFont.value);
        </script>
      </body>
    </html>`);
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/agents/${AGENT_ID}/chat`,
  });

  const { document: frameDocument } = await openReadyPresentation(objectUrls);
  const rootStyle = computedStyle(frameDocument.documentElement);

  expect(rootStyle.getPropertyValue("--bg").trim()).toBe("#FFFDF7");
  expect(rootStyle.getPropertyValue("--accent").trim()).toBe("#FF7A1A");
  expect(rootStyle.getPropertyValue("--fd")).toContain("Fraunces");
  expect(rootStyle.getPropertyValue("--fb")).toContain("Inter");
  expect(
    frameDocument.querySelector('[data-okou-materialized-theme="true"]'),
  ).not.toBeNull();
  expect(frameDocument.querySelector("script")).toBeNull();
  expect(elementBySelector(frameDocument, ".themed-slide")).toHaveTextContent(
    "Selected generated theme",
  );
});
