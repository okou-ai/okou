import CCStateSwiftUI
import ChatData
import SwiftUI

struct OnboardingIndustryContent: View {
  let store: OnboardingStore
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
            OkouSelectionIndicator(isSelected: store.draft.answers.industry == id)
          }
          .padding(.vertical, OkouSpace.xs)
          .contentShape(Rectangle())
        }
        .accessibilityValue(store.draft.answers.industry == id ? "Selected" : "Not selected")
        .accessibilityIdentifier("onboarding-industry-\(id)")
      }
    }
  }
}

struct OnboardingExperienceContent: View {
  let store: OnboardingStore
  let onConnect: () -> Void

  var body: some View {
    Section {
      choice("I use Codex", provider: "codex", experienced: true)
      choice("I use Claude Code", provider: "claudeCode", experienced: true)
      choice("I've tried AI assistants", provider: nil, experienced: true)
      choice("I'm just getting started", provider: nil, experienced: false)
    }
    if store.draft.answers.provider != nil {
      Section {
        Button(action: onConnect) {
          OkouRowLabel("Connect subscription", okouSymbol: "plus")
        }
        ForEach(store.subscriptions.accounts.filter { !$0.needsReconnect }) { account in
          Label(
            "\(account.accountEmail ?? account.workspaceName ?? "Account") connected",
            okouSymbol: "check"
          )
          .foregroundStyle(OkouColor.mutedForeground)
        }
      } footer: {
        Text("Optional. Okou can also run tasks without a personal AI subscription.")
          .okouSectionNote()
      }
    }
  }

  private func choice(_ title: LocalizedStringKey, provider: String?, experienced: Bool)
    -> some View
  {
    let selected =
      store.draft.answers.experienced == experienced && store.draft.answers.provider == provider
    return Button {
      store.selectExperience(experienced, provider: provider)
    } label: {
      HStack(spacing: OkouSpace.md) {
        Text(title).foregroundStyle(OkouColor.foreground)
        Spacer()
        OkouSelectionIndicator(isSelected: selected)
      }
      .contentShape(Rectangle())
      .padding(.vertical, OkouSpace.xs)
    }
    .accessibilityValue(selected ? "Selected" : "Not selected")
  }
}

struct OnboardingSkillsContent: View {
  let store: OnboardingStore
  @State private var copied = false
  var body: some View {
    Section {
      Button {
        guard let prompt = store.skillPrompt else { return }
        UIPasteboard.general.setItems(
          [[UIPasteboard.typeAutomatic: prompt]],
          options: [.localOnly: true, .expirationDate: store.skillSession?.expiresAt ?? .now])
        copied = true
      } label: {
        OkouRowLabel(
          copied ? "Prompt copied" : "Copy import prompt", okouSymbol: copied ? "check" : "copy")
      }
      .disabled(store.skillPrompt == nil)
      Button("Check for imported skills") { Task { await store.prepareSkills() } }
      ForEach(store.importedSkills) { skill in
        Label(skill.name, okouSymbol: "check")
      }
    } footer: {
      Text(
        "Paste the prompt into Codex or Claude Code on your computer. It imports your skills as private workflows. You can do this later."
      )
      .okouSectionNote()
    }
    .task { await store.prepareSkills() }
  }
}

struct OnboardingReadyContent: View {
  @Bindable var store: OnboardingStore
  @FocusState private var isFocused: Bool
  @LoadableValue private var recommendation: Loadable<OnboardingRecommendation?>

  init(store: OnboardingStore) {
    self.store = store
    _recommendation = LoadableValue(task: store.resources.recommendation)
  }

  var body: some View {
    Section {
      if let value = recommendation.data?.recommendation {
        Text(value.title).font(.okou(.headline))
        Text(value.outcome).foregroundStyle(OkouColor.mutedForeground)
        Text(value.profile.overview).font(.okou(.footnote)).foregroundStyle(
          OkouColor.mutedForeground)
      }
      TextField(
        "What would you like Okou to do?",
        text: Binding(get: { store.draft.answers.startingPromptDraft }, set: store.editPrompt),
        axis: .vertical
      )
      .lineLimit(4...8)
      .focused($isFocused)
      .accessibilityIdentifier("onboarding-first-task")
      Picker(
        "Output format",
        selection: Binding(
          get: { store.draft.answers.startingPromptOutput?.format ?? "none" },
          set: store.selectOutputFormat)
      ) {
        Text("Let Okou choose").tag("none")
        Text("Image").tag("image")
        Text("Presentation").tag("presentation")
        Text("Website").tag("website")
        Text("Report").tag("report")
        Text("Research").tag("research")
        Text("People").tag("people")
      }
      Button("Refresh suggestion") { Task { await store.refreshReady() } }
    } footer: {
      Text("Your task will open in the chat composer so you can review it before sending.")
        .okouSectionNote()
    }
    .task { await store.refreshReady() }
  }
}
