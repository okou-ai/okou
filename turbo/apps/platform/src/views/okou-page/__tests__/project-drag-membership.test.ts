import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  membershipPage,
  drag,
  indicator,
  checkLocation,
} from "./project-chat-membership-fixtures.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const moves = [
  { id: "projects-032", moving: "outside", action: "Move to Launch" },
  { id: "projects-033", moving: "member", action: "Remove from Project" },
] as const;
test.each(moves)(
  "$id Dropping a chat on another row shows $action and applies that membership before and after confirmation",
  async ({ moving, action }) => {
    const state = await membershipPage(context, moving);
    const toProject = moving === "outside",
      source = toProject ? state.outside : state.member,
      target = toProject ? state.member : state.outside;
    const dest = toProject ? state.launch.id : null;
    const transfer = await drag(source.title!, target.title!);
    const hint = await indicator(action);
    transfer.drop();
    await state.received;
    await waitFor(() => {
      checkLocation(source.title!, dest);
      expect(hint).not.toBeInTheDocument();
    });
    expect(location.pathname).toBe(state.path);
    await state.fold("Launch", false);
    expect(Boolean(queryFastControl("link", source.title!))).toBe(!toProject);
    await state.fold("Launch", true);
    state.save.resolve();
    const confirmed = source.title + " confirmed";
    await findFastControl("link", confirmed);
    checkLocation(confirmed, dest);
    expect(location.pathname).toBe(state.path);
    expect(state.requests).toStrictEqual([{ chat: source.id, project: dest }]);
  },
);
test("projects-036 Escape cancels the move and neither existing membership nor an external URL becomes an accepted drop", async () => {
  const state = await membershipPage(context);
  const folder = "Show or hide chats in Launch";
  const attempt = await drag(state.outside.title!, folder, "button");
  const hint = await indicator("Move to Launch");
  fireEvent.keyDown(attempt.from, { key: "Escape" });
  await waitFor(() => {
    return expect(hint).not.toBeInTheDocument();
  });
  attempt.drop();
  checkLocation(state.outside.title!, null);
  const own = await drag(state.member.title!, folder, "button");
  expect(screen.queryByRole("tooltip")).toBeNull();
  own.drop();
  fireEvent.dragEnd(own.from, { dataTransfer: own.data });
  const outside = new DataTransfer();
  outside.setData("text/uri-list", "https://external.example");
  fireEvent.dragOver(own.to, { dataTransfer: outside });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.drop(own.to, { dataTransfer: outside });
  checkLocation(state.member.title!, state.launch.id);
  expect(state.requests).toStrictEqual([]);
  expect(location.pathname).toBe(state.path);
});
