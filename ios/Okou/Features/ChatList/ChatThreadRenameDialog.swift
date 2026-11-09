import SwiftUI

/// Chat and Project names share one native editor and its presentation/focus contract.
struct ChatThreadRenameDialog: View {
  let list: ThreadListStore

  var body: some View {
    OkouNameDialog(
      request: list.renameRequest.map { request in
        OkouNameDialog.Request(
          id: request.id, title: String(localized: "Rename chat"),
          placeholder: String(localized: "Chat title"), name: list.renameTitle,
          error: request.error, accessibilityIdentifier: "chat-rename-title")
      },
      cancel: list.cancelRename,
      save: { name in
        list.renameTitle = name
        Task { await list.saveRename() }
      })
  }
}
