import CCState
import CCStateSwiftUI
import ChatData
import SwiftUI

/// Both sidebar and membership picker observe the original workspace Project Task.
struct ChatProjectReadStatus: View {
  let projects: ChatProjectStore

  var body: some View {
    StoreProvider(projects.stateStore) {
      ChatProjectReadFeedback(projects: projects)
    }
    .task { await projects.activate() }
  }
}

private struct ChatProjectReadFeedback: View {
  let projects: ChatProjectStore
  @LoadableValue private var value: Loadable<[ChatProject]>

  init(projects: ChatProjectStore) {
    self.projects = projects
    _value = LoadableValue(task: projects.value)
  }

  var body: some View {
    switch value {
    case .loading:
      if projects.projects.isEmpty { OkouLoadingRow("Loading projects…") }
    case .hasError(let error):
      if !(error is CancellationError) {
        OkouLoadErrorRow(message: error.localizedDescription, actionTitle: "Retry") {
          await projects.refresh()
        }
      }
    case .hasData:
      EmptyView()
    }
  }
}
