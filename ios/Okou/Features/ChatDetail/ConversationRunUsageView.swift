import ChatData
import SwiftUI

struct ConversationRunUsageView: View {
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
            Image(systemName: "circle.grid.2x2").accessibilityHidden(true)
            if case .available(let usage) = state {
              Text(CreditUsageDisplay.credits(usage.totalCredits)).monospacedDigit()
            } else {
              Text("Usage unavailable")
            }
          }
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(minWidth: 44, minHeight: 44, alignment: .leading)
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
          Text("Settled usage is not available for this run.").foregroundStyle(.secondary)
          Button("Try again", action: retry)
        case .failed(let message):
          Text(message).foregroundStyle(.secondary)
          Button("Try again", action: retry)
        }
      }
      .navigationTitle("Credit usage")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
  }
}
