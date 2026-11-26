import CCStateSwiftUI
import ChatData
import SwiftUI

struct OnboardingIndustryContent: View {
  let store: OnboardingStore
  @ResolvedValue private var state: OnboardingStore.Snapshot?

  init(store: OnboardingStore) {
    self.store = store
    _state = ResolvedValue(store.value)
  }

  private let industries: [(String, LocalizedStringKey)] = [
    ("marketing", "Marketing"), ("design", "Design"), ("consulting", "Consulting"),
    ("coaching", "Coaching"), ("finance", "Finance"), ("operations", "Operations"),
    ("sales", "Sales"), ("software", "Software engineering"), ("research", "Research"),
    ("investing", "Investing"), ("other", "Something else")
  ]

  var body: some View {
    Section {
      ForEach(industries, id: \.0) { id, title in
        Button {
          store.selectIndustry(id)
        } label: {
          HStack(spacing: OkouSpace.md) {
            Text(title).foregroundStyle(OkouColor.foreground)
            Spacer(minLength: OkouSpace.sm)
            OkouSelectionIndicator(
              isSelected: (state ?? store.snapshot).draft.answers.industry == id)
          }
          .padding(.vertical, OkouSpace.xs)
          .contentShape(Rectangle())
        }
        .accessibilityValue(
          (state ?? store.snapshot).draft.answers.industry == id ? "Selected" : "Not selected"
        )
        .accessibilityIdentifier("onboarding-industry-\(id)")
      }
    }
  }
}

struct OnboardingReadyContent: View {
  let store: OnboardingStore
  @ResolvedValue private var resolvedState: OnboardingStore.Snapshot?
  @FocusState private var isFocused: Bool
  @LoadableValue private var recommendation: Loadable<OnboardingRecommendation?>

  init(store: OnboardingStore) {
    self.store = store
    _resolvedState = ResolvedValue(store.value)
    _recommendation = LoadableValue(task: store.resources.recommendation, keepLast: true)
  }

  private var state: OnboardingStore.Snapshot { resolvedState ?? store.snapshot }

  var body: some View {
    Section {
      switch recommendation {
      case .loading:
        if state.draft.answers.recommendationJobId != nil {
          OkouLoadingRow("Finding a task for you…")
        }
      case .hasError(let error):
        OkouLoadErrorRow(message: ChatRequestFailure.message(for: error)) {
          Task { await store.refreshReady() }
        }
      case .hasData(let job):
        if let value = job?.recommendation {
          Text(value.title).font(.okou(.headline))
          Text(value.outcome).foregroundStyle(OkouColor.mutedForeground)
        } else if job?.status == "pending" || job?.status == "running" {
          OkouLoadingRow("Finding a task for you…")
        }
      }
      TextField(
        "What would you like Okou to do?",
        text: Binding(get: { state.draft.answers.startingPromptDraft }, set: store.editPrompt),
        axis: .vertical
      )
      .lineLimit(4...8)
      .focused($isFocused)
      .disabled(!state.canEdit)
      .disabled(!state.canEdit)
      .accessibilityIdentifier("onboarding-first-task")
      if state.task != nil {
        Text("Retry to confirm this task's result before starting another.")
          .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
      }
    } footer: {
      Text("Confirm and run sends this task to a new chat. You can follow its progress there.")
        .okouSectionNote()
    }
    .task { await store.refreshReady() }
  }
}
