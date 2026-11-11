import CCStateSwiftUI
import ChatData
import SwiftUI

struct ComposerWorkflowMenu: View {
  let suggestions: ComposerWorkflowSuggestions
  let availableHeight: CGFloat
  var body: some View {
    StoreProvider(suggestions.resources.store) {
      ComposerWorkflowContent(suggestions: suggestions, availableHeight: availableHeight)
        .id(ObjectIdentifier(suggestions))
    }
  }
}

private struct ComposerWorkflowContent: View {
  private struct ResultIdentity: Hashable {
    let requestID: UUID?
    let query: String?
  }

  let suggestions: ComposerWorkflowSuggestions
  let availableHeight: CGFloat
  @LoadableValue private var results: Loadable<ComposerWorkflowResources.Matches>

  init(suggestions: ComposerWorkflowSuggestions, availableHeight: CGFloat) {
    self.suggestions = suggestions
    self.availableHeight = availableHeight
    _results = LoadableValue(task: suggestions.resources.matches)
  }

  var body: some View {
    OkouSuggestionPanel(
      title: "Workflows", availableHeight: availableHeight,
      dismissLabel: "Dismiss Workflow suggestions", dismissIdentifier: "dismiss-workflows",
      dismiss: suggestions.dismiss
    ) { height in
      content(maximumHeight: min(OkouControl.suggestionListHeight, height))
    }
    .accessibilityIdentifier("workflow-menu")
  }

  @ViewBuilder
  private func content(maximumHeight: CGFloat) -> some View {
    switch results {
    case .loading:
      OkouLoadingRow("Loading Workflows…").padding(.horizontal, OkouSpace.lg)
    case .hasError(let error):
      VStack(alignment: .leading, spacing: OkouSpace.sm) {
        Text(error.localizedDescription).font(.okou(.caption)).foregroundStyle(
          OkouColor.mutedForeground)
        Button("Retry Workflows") { suggestions.reload() }.frame(
          minHeight: OkouControl.minimumTarget)
      }.padding(.horizontal, OkouSpace.lg)
    case .hasData(let result) where result.values.isEmpty:
      Text("No matching Workflows").font(.okou(.subheadline)).foregroundStyle(
        OkouColor.mutedForeground
      )
      .padding(OkouSpace.lg)
    case .hasData(let result):
      ComposerSuggestionTable(
        items: result.values.map { workflow in
          ComposerSuggestionItem(
            id: "workflow-" + workflow.id,
            title: workflow.displayName ?? workflow.name,
            detail: workflow.description,
            command: "/" + workflow.name,
            accessibilityLabel: [workflow.displayName ?? workflow.name, workflow.description]
              .compactMap { $0 }.joined(separator: ", "),
            accessibilityHint: String(localized: "Inserts this Workflow into your message"))
        },
        selectedIndex: suggestions.selectedIndex,
        maximumHeight: maximumHeight,
        accessibilityIdentifier: "workflow-suggestions",
        activate: { id in
          guard let workflow = result.values.first(where: { "workflow-" + $0.id == id }) else {
            return
          }
          suggestions.insert(workflow)
        },
        didDisplay: { owner in suggestions.registerRows(owner) { result } },
        didDismantle: suggestions.unregisterRows
      )
      // A new search owns fresh native scroll and self-sizing state.
      .id(ResultIdentity(requestID: result.requestID, query: result.query))
    }
  }
}
