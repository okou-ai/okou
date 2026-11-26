import CCStateSwiftUI
import SwiftUI

/// Chat and Project names share one native editor and its presentation/focus contract. The
/// rename request and its title are read from the workspace session's Store.
struct ChatThreadRenameDialog: View {
  let list: ThreadListStore
  @ResolvedValue private var status: ThreadListStore.Status?

  init(list: ThreadListStore) {
    self.list = list
    _status = ResolvedValue(list.statusValue)
  }

  var body: some View {
    let current = status ?? list.status
    OkouNameDialog(
      request: current.renameRequest.map { request in
        OkouNameDialog.Request(
          id: request.id, title: String(localized: "Rename chat"),
          placeholder: String(localized: "Chat title"), name: current.renameTitle,
          error: request.error, accessibilityIdentifier: "chat-rename-title")
      },
      cancel: list.cancelRename,
      save: { name in
        list.renameTitle = name
        Task { await list.saveRename() }
      })
  }
}
