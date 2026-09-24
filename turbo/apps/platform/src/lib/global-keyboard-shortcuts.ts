export const GLOBAL_KEYBOARD_SHORTCUTS = {
  searchWorkspace: {
    binding: "mod+shift+f",
    ariaKeyShortcuts: "Meta+Shift+F Control+Shift+F",
  },
  newChat: {
    binding: "mod+shift+o",
    ariaKeyShortcuts: "Meta+Shift+O Control+Shift+O",
  },
  toggleChatList: {
    binding: "mod+b",
    ariaKeyShortcuts: "Meta+B Control+B",
  },
  toggleUnreadOnly: {
    binding: "mod+shift+u",
    ariaKeyShortcuts: "Meta+Shift+U Control+Shift+U",
  },
  renameChat: {
    binding: "f2",
    ariaKeyShortcuts: "F2",
  },
  toggleChatPin: {
    binding: "mod+shift+d",
    ariaKeyShortcuts: "Meta+Shift+D Control+Shift+D",
  },
  toggleChatArchive: {
    binding: "mod+shift+x",
    ariaKeyShortcuts: "Meta+Shift+X Control+Shift+X",
  },
} as const;
