import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openMessageFile } from "./chat-artifact-preview-test-helpers.ts";
import { artifactFile } from "./chat-attachment-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();

async function gallery() {
  const files = ["first.png", "second.png", "third.png"].map((name) => {
    return artifactFile(name, { contentType: "image/png" });
  });
  await openMessageFile(context, files[0]!, { relatedFiles: files.slice(1) });
  const owner = await screen.findByRole("group", { name: "first.png preview" });
  owner.focus();
  return owner;
}
test("chat-image-navigation-shortcuts-001 the last image bounds arrow navigation", async () => {
  await gallery();
  await userEvent.keyboard("{ArrowRight}");
  await screen.findByRole("group", { name: "second.png preview" });
  await userEvent.keyboard("{ArrowRight}");
  const last = await screen.findByRole("group", { name: "third.png preview" });
  expect(queryFastControl("button", "Next image", last)).toBeNull();
  await userEvent.keyboard("{ArrowRight}");
  expect(last).toHaveAccessibleName("third.png preview");
  await userEvent.keyboard("{ArrowLeft}");
  await screen.findByRole("group", { name: "second.png preview" });
});

test("chat-image-navigation-shortcuts-007 modifiers, menus and fullscreen focus determine which gallery receives arrows", async () => {
  const stage = await gallery();
  for (const key of ["Alt", "Control", "Meta", "Shift"]) {
    await userEvent.keyboard("{" + key + ">}{ArrowRight}{/" + key + "}");
    expect(stage).toHaveAccessibleName("first.png preview");
  }
  const menu = await findFastControl(
    "button",
    /Download options|Download menu/i,
  );
  click(menu);
  await userEvent.keyboard("{ArrowRight}");
  expect(stage).toHaveAccessibleName("first.png preview");
  await userEvent.keyboard("{Escape}");
  click(await findFastControl("button", "Enter fullscreen"));
  await userEvent.keyboard("{ArrowRight}");
  expect(stage).toHaveAccessibleName("first.png preview");
  stage.focus();
  await userEvent.keyboard("{ArrowRight}");
  await screen.findByRole("group", { name: "second.png preview" });
  click(await findFastControl("button", /open in split view/i));
  click(await findFastControl("button", "Enter fullscreen"));
  await userEvent.keyboard("{ArrowRight}");
  const side = await screen.findByRole("group", { name: "second.png preview" });
  side.focus();
  await userEvent.keyboard("{ArrowRight}");
  await screen.findByRole("group", { name: "third.png preview" });
  click(await findFastControl("button", "Exit fullscreen"));
  const third = await screen.findByRole("group", { name: "third.png preview" });
  third.focus();
  await userEvent.keyboard("{ArrowLeft}");
  await screen.findByRole("group", { name: "second.png preview" });
});
