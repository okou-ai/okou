import SwiftUI

/// The system owns the back button and transition; model and chat actions stay in its toolbar.
struct ChatWorkspaceToolbar: ToolbarContent {
  let store: WorkspaceStore
  let modelSelection: ChatModelSelectionStore

  var body: some ToolbarContent {
    ToolbarItem(placement: .principal) {
      ChatModelPickerButton(selection: modelSelection)
        .disabled(store.needsUpgrade)
    }
    ToolbarItem(placement: .topBarTrailing) {
      if let threadID = store.selectedThreadID {
        ChatThreadMoreButton(store: store, threadID: threadID)
      }
    }
    .sharedBackgroundVisibility(.hidden)
  }
}
