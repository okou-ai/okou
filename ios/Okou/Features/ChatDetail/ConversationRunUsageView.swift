import CCStateSwiftUI
import ChatData
import SwiftUI

enum ConversationRunUsageState: Equatable {
  case loading
  case available(ChatRunUsage)
  case unavailable
  case failed(String)

  init(_ value: Loadable<ChatRunUsage?>) {
    switch value {
    case .loading: self = .loading
    case .hasData(let usage): self = usage.map(Self.available) ?? .unavailable
    case .hasError(let error): self = .failed(ChatRequestFailure.message(for: error))
    }
  }
}

struct ConversationRunUsageView: View {
  let runID: String
  let usage: ConversationRunUsageStore
  let showDetails: () -> Void

  var body: some View {
    StoreProvider(usage.stateStore) {
      if let resource = usage.resources[runID] {
        RunUsageValue(resource: resource) { state in
          ConversationRunUsageLabel(runID: runID, state: state, showDetails: showDetails)
        }
        .id(ObjectIdentifier(resource))
      } else {
        ConversationRunUsageLabel(runID: runID, state: .loading, showDetails: showDetails)
      }
    }
  }
}

private struct RunUsageValue<Content: View>: View {
  @LoadableValue private var value: Loadable<ChatRunUsage?>
  let content: (ConversationRunUsageState) -> Content

  init(
    resource: ConversationRunUsageResource,
    @ViewBuilder content: @escaping (ConversationRunUsageState) -> Content
  ) {
    _value = LoadableValue(task: resource.value, keepLast: true)
    self.content = content
  }

  var body: some View { content(ConversationRunUsageState(value)) }
}

private struct ConversationRunUsageLabel: View {
  let runID: String
  let state: ConversationRunUsageState
  let showDetails: () -> Void

  var body: some View {
    Group {
      if case .loading = state {
        Color.clear.frame(height: 44).accessibilityHidden(true)
      } else {
        Button(action: showDetails) {
          HStack(spacing: 5) {
            OkouIcon("layout-grid", size: OkouIconSize.inline).accessibilityHidden(true)
            if case .available(let usage) = state {
              Text(CreditUsageDisplay.credits(usage.totalCredits)).monospacedDigit()
            } else {
              Text("Usage unavailable")
            }
          }
          .font(.okou(.caption))
          .foregroundStyle(OkouColor.mutedForeground)
          .frame(minWidth: 44, minHeight: OkouControl.minimumTarget, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Credit usage")
        .accessibilityValue(value)
        .accessibilityIdentifier("credit-usage:\(runID)")
      }
    }
  }

  private var value: String {
    if case .available(let usage) = state { return CreditUsageDisplay.credits(usage.totalCredits) }
    return String(localized: "Usage unavailable")
  }
}

struct ConversationRunUsageDetails: View {
  let usage: ConversationRunUsageStore
  let runID: String
  let catalog: ModelCatalog?
  let retry: () -> Void

  var body: some View {
    StoreProvider(usage.stateStore) {
      if let resource = usage.resources[runID] {
        RunUsageValue(resource: resource) { state in
          ConversationRunUsageDetailsContent(state: state, catalog: catalog, retry: retry)
        }
        .id(ObjectIdentifier(resource))
      } else {
        ConversationRunUsageDetailsContent(state: .loading, catalog: catalog, retry: retry)
      }
    }
  }
}

private struct ConversationRunUsageDetailsContent: View {
  let state: ConversationRunUsageState
  let catalog: ModelCatalog?
  let retry: () -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        switch state {
        case .available(let usage):
          LabeledContent("Total credits", value: CreditUsageDisplay.credits(usage.totalCredits))
            .fontWeight(.semibold)
          ForEach(CreditUsageDisplay.rows(usage, catalog: catalog)) { row in
            LabeledContent(row.label, value: CreditUsageDisplay.credits(row.credits))
          }
        case .loading:
          ProgressView().accessibilityLabel("Loading credit usage")
        case .unavailable:
          Text("Settled usage is not available for this run.").foregroundStyle(
            OkouColor.mutedForeground)
          Button("Try again", action: retry)
        case .failed(let message):
          Text(message).foregroundStyle(OkouColor.mutedForeground)
          Button("Try again", action: retry)
        }
      }
      .okouGroupedBackground()
      .navigationTitle("Credit usage")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { OkouCloseToolbarItem { dismiss() } }
    }
  }
}
