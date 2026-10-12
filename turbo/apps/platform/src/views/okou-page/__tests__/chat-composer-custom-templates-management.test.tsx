import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  buttonByName,
  customTemplate,
  mockCustomTemplateStore,
  openCustomPanel,
  tabByText,
} from "./chat-composer-custom-template-test-helpers.ts";

function menuItemByName(name: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected a menu item named "${name}"`);
  }
  return item;
}

async function openDetail(
  dialog: HTMLElement,
  title: string,
): Promise<HTMLElement> {
  click(tabByText("Custom"));
  await within(dialog).findByText(title);
  click(buttonByName(`Preview ${title}`, dialog)!);
  // The preview dialog is portaled out of the picker, so the editor is found
  // on the document rather than inside the panel that opened it.
  return screen.findByLabelText("Rename template");
}

/** Leave the open template, which is what the dialog's breadcrumb does. */
function closeDetail(): void {
  click(buttonByName("Custom templates")!);
}

test("Clearing the title and leaving the field keeps the template named", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel();
  const input = await openDetail(dialog, "Q3 board review");

  await fill(input, "");
  fireEvent.blur(input);
  closeDetail();

  // A blank field is a slip, not a request to erase the name.
  await expect(
    within(dialog).findByText("Q3 board review"),
  ).resolves.toBeInTheDocument();
});

test("Renaming a template updates its card in the panel", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel();
  const input = await openDetail(dialog, "Q3 board review");

  await fill(input, "  Board   review FY26  ");
  fireEvent.blur(input);
  closeDetail();

  // Surrounding and repeated whitespace is collapsed before it is stored.
  await expect(
    within(dialog).findByText("Board review FY26"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Q3 board review")).not.toBeInTheDocument();
});

test.each([
  { mode: "composing", isComposing: true, keyCode: 13, title: "季度 报告" },
  {
    mode: "Safari final Enter",
    isComposing: false,
    keyCode: 229,
    title: "四半期 レポート",
  },
])(
  "Confirming an IME candidate ($mode) keeps the template name focused and unsaved",
  async ({ isComposing, keyCode, title }) => {
    const user = userEvent.setup({ delay: null });
    mockCustomTemplateStore([customTemplate()]);
    const { dialog } = await openCustomPanel();
    const input = await openDetail(dialog, "Q3 board review");

    fireEvent.compositionStart(input);
    await fill(input, `  ${title}  `);
    if (!isComposing) {
      fireEvent.compositionEnd(input, { data: title });
    }
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      isComposing,
      keyCode,
    });

    expect(input).toHaveFocus();
    expect(input).toBeEnabled();
    expect(input).toHaveValue(`  ${title}  `);
    expect(within(dialog).getByText("Q3 board review")).toBeInTheDocument();

    if (isComposing) {
      fireEvent.compositionEnd(input, { data: title });
    }
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(renameField()).toHaveValue(title);
    });
    expect(renameField()).not.toHaveFocus();
    expect(renameField()).toBeEnabled();
    closeDetail();
    await expect(within(dialog).findByText(title)).resolves.toBeInTheDocument();
  },
);

function renameField(): HTMLElement {
  return screen.getByLabelText("Rename template");
}

async function shareWithOrganization(): Promise<void> {
  click(buttonByName("Change")!);
  const organization = await waitFor(() => {
    const option = queryAllByRoleFast("menuitemradio").find((candidate) => {
      return candidate.textContent?.startsWith("Organization");
    });
    if (!option) {
      throw new Error("Expected an Organization visibility option");
    }
    return option;
  });
  click(organization);
}

test("A rejected rename keeps the typed name", async () => {
  mockCustomTemplateStore([customTemplate()], {
    update: () => {
      return "fail";
    },
  });

  const { dialog } = await openCustomPanel();
  const input = await openDetail(dialog, "Q3 board review");

  await fill(input, "Board review FY26");
  fireEvent.blur(input);

  await expect(
    screen.findByText("Couldn't rename the template."),
  ).resolves.toBeInTheDocument();
  // The name the server refused is still in the field: it is the member's
  // work, and throwing it away would make them type it a second time.
  expect(renameField()).toBeEnabled();
  expect(renameField()).toHaveValue("Board review FY26");
});

test("Changing visibility updates the card's meta line", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel();
  await openDetail(dialog, "Q3 board review");

  await shareWithOrganization();
  closeDetail();

  await expect(
    within(dialog).findByText("Organization"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Private")).not.toBeInTheDocument();
});

test("Deleting a template removes only its card", async () => {
  const board = customTemplate();
  const renewal = customTemplate({
    id: "22222222-2222-4222-8222-222222222222",
    title: "Renewal deck",
  });
  mockCustomTemplateStore([board, renewal]);

  const { dialog } = await openCustomPanel();
  await within(dialog).findByText(board.title);

  click(buttonByName("Actions for Q3 board review", dialog)!);
  await waitFor(() => {
    expect(menuItemByName("Delete")).toBeInTheDocument();
  });
  click(menuItemByName("Delete"));
  // Removal cannot be undone, so the menu asks first and changes nothing yet.
  const confirm = await screen.findByRole("dialog", {
    name: "Delete template?",
  });
  expect(within(dialog).getByText(board.title)).toBeInTheDocument();
  click(buttonByName("Delete template", confirm)!);

  await waitFor(() => {
    expect(within(dialog).queryByText(board.title)).not.toBeInTheDocument();
  });
  expect(within(dialog).getByText(renewal.title)).toBeInTheDocument();
});

test("Cancelling the delete confirmation keeps the template", async () => {
  mockCustomTemplateStore([customTemplate()]);

  const { dialog } = await openCustomPanel();
  await within(dialog).findByText("Q3 board review");

  click(buttonByName("Actions for Q3 board review", dialog)!);
  await waitFor(() => {
    expect(menuItemByName("Delete")).toBeInTheDocument();
  });
  click(menuItemByName("Delete"));
  const confirm = await screen.findByRole("dialog", {
    name: "Delete template?",
  });
  click(buttonByName("Cancel", confirm)!);

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Delete template?" }),
    ).not.toBeInTheDocument();
  });
  expect(within(dialog).getByText("Q3 board review")).toBeInTheDocument();
});

test("A failed deletion is not reported again on the next confirmation", async () => {
  let deletions = 0;
  mockCustomTemplateStore([customTemplate()], {
    delete: () => {
      deletions += 1;
      return deletions === 1 ? "fail" : undefined;
    },
  });

  const { dialog } = await openCustomPanel();
  await within(dialog).findByText("Q3 board review");

  const askToDelete = async () => {
    click(buttonByName("Actions for Q3 board review", dialog)!);
    await waitFor(() => {
      expect(menuItemByName("Delete")).toBeInTheDocument();
    });
    click(menuItemByName("Delete"));
    return await screen.findByRole("dialog", { name: "Delete template?" });
  };

  const first = await askToDelete();
  click(buttonByName("Delete template", first)!);
  await expect(
    within(first).findByText("Couldn't delete the template. Try again."),
  ).resolves.toBeInTheDocument();
  click(buttonByName("Cancel", first)!);
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Delete template?" }),
    ).not.toBeInTheDocument();
  });

  // The next question is about a request that has not been made yet.
  const second = await askToDelete();
  expect(within(second).getByText(/Q3 board review/)).toBeInTheDocument();
  expect(
    within(second).queryByText("Couldn't delete the template. Try again."),
  ).not.toBeInTheDocument();

  click(buttonByName("Delete template", second)!);
  await waitFor(() => {
    expect(within(dialog).queryByText("Q3 board review")).toBeNull();
  });
});

test.each(["visibility change", "deletion"] as const)(
  "A failed %s keeps the template and reports the error",
  async (operation) => {
    mockCustomTemplateStore([customTemplate()], {
      update: () => {
        return operation === "visibility change" ? "fail" : undefined;
      },
      delete: () => {
        return operation === "deletion" ? "fail" : undefined;
      },
    });

    const { dialog } = await openCustomPanel();
    await openDetail(dialog, "Q3 board review");

    if (operation === "visibility change") {
      await shareWithOrganization();
    } else {
      click(buttonByName("Delete")!);
      const confirm = await screen.findByRole("dialog", {
        name: "Delete template?",
      });
      click(buttonByName("Delete template", confirm)!);
    }

    await expect(
      screen.findByText("User template request failed"),
    ).resolves.toBeInTheDocument();
    expect(renameField()).toHaveValue("Q3 board review");
    expect(screen.getByText("Only you can see and use it")).toBeInTheDocument();
    expect(within(dialog).getByText("Q3 board review")).toBeInTheDocument();
    expect(within(dialog).getByText("Private")).toBeInTheDocument();
  },
);
