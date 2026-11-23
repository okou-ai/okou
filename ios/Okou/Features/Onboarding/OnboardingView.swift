import CCStateSwiftUI
import ChatData
import SwiftUI

struct OnboardingGate<Content: View>: View {
  let store: OnboardingStore
  let needsUpgrade: Bool
  @ViewBuilder let content: () -> Content

  var body: some View {
    StoreProvider(store.resources.store) {
      OnboardingGateContent(store: store, needsUpgrade: needsUpgrade, content: content)
    }
  }
}

private struct OnboardingGateContent<Content: View>: View {
  let store: OnboardingStore
  let needsUpgrade: Bool
  let content: () -> Content
  @LoadableValue private var status: Loadable<OnboardingStatus>

  init(store: OnboardingStore, needsUpgrade: Bool, content: @escaping () -> Content) {
    self.store = store
    self.needsUpgrade = needsUpgrade
    self.content = content
    _status = LoadableValue(task: store.resources.status)
  }

  var body: some View {
    Group {
      if needsUpgrade {
        OkouEmptyState(
          "Update required", icon: "download",
          description: Text("Install the latest Okou build to continue.")
        ) {
          Link("Open TestFlight", destination: URL(string: "itms-beta://")!)
            .buttonStyle(OkouButtonStyle(isPrimary: true))
        }
      } else {
        switch status {
        case .loading:
          ChatSettingsLoadingView(title: "Getting your workspace ready…")
        case .hasError(let error):
          OkouEmptyState(
            "Unable to load your workspace", icon: "triangle-alert",
            description: Text(ChatRequestFailure.message(for: error))
          ) {
            Button("Try again") { retryStatus() }
              .buttonStyle(OkouButtonStyle(isPrimary: true))
          }
        case .hasData(let value):
          if value.presentsOnboarding {
            OnboardingView(store: store)
          } else {
            content()
          }
        }
      }
    }
    .background(OkouColor.background.ignoresSafeArea())
  }

  private func retryStatus() {
    do { try store.resources.retry(.status) } catch { /* Retired owners cannot retry. */  }
  }
}

struct OnboardingView: View {
  @Bindable var store: OnboardingStore
  @State private var showsConnectors = false
  @State private var showsSubscriptions = false
  @State private var channelURL: URL?
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack {
      Group {
        if store.isPrepared {
          stepContent
        } else if let error = store.error {
          OkouEmptyState(
            "Unable to restore setup", icon: "triangle-alert", description: Text(error)
          ) {
            Button("Try again") { Task { await store.retryPreparation() } }
              .buttonStyle(OkouButtonStyle(isPrimary: true))
          }
        } else {
          ChatSettingsLoadingView(title: "Getting things ready…")
        }
      }
      .navigationTitle("Set up Okou")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          if store.stepIndex > 0 {
            Button("Back", okouSymbol: "chevron-left") { Task { await store.back() } }
              .disabled(store.isWorking)
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Text("\(store.stepIndex + 1) of \(store.steps.count)")
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
            .accessibilityLabel("Step \(store.stepIndex + 1) of \(store.steps.count)")
        }
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if store.isPrepared { footer }
      }
      .sheet(isPresented: $showsConnectors) {
        ComposerConnectorSheet(store: store.connectors)
      }
      .sheet(isPresented: $showsSubscriptions) {
        NavigationStack {
          PersonalSubscriptionsView(store: store.subscriptions)
            .toolbar { OkouCloseToolbarItem { showsSubscriptions = false } }
        }
      }
      .sheet(isPresented: Binding(get: { channelURL != nil }, set: { if !$0 { channelURL = nil } }))
      {
        if let channelURL { ConnectorSafariView(url: channelURL) { self.channelURL = nil } }
      }
    }
    .task { await store.prepare() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active, store.step == .ready { Task { await store.refreshReady() } }
      if phase == .active, store.step == .skills { Task { await store.prepareSkills() } }
    }
  }

  private var stepContent: some View {
    List {
      Section {
        VStack(alignment: .leading, spacing: OkouSpace.md) {
          Text(store.step.title).font(.okou(.title).weight(.semibold))
            .accessibilityAddTraits(.isHeader)
          Text(store.step.detail).font(.okou(.subheadline))
            .foregroundStyle(OkouColor.mutedForeground)
        }
        .padding(.vertical, OkouSpace.md)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      }
      switch store.step {
      case .industry: OnboardingIndustryContent(store: store)
      case .sources:
        OnboardingSourcesContent(
          store: store, isBrowsing: showsConnectors, showAll: { showsConnectors = true })
      case .experience:
        OnboardingExperienceContent(store: store, connect: { showsSubscriptions = true })
      case .skills: OnboardingSkillsContent(store: store)
      case .slack:
        Section {
          Button {
            channelURL = store.connectors.webURL.appending(path: "works")
          } label: {
            OkouRowLabel("Connect chat apps", okouSymbol: "messages-square")
          }
          Text("Slack, Microsoft Teams, Discord, Telegram and iMessage")
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        } footer: {
          Text(
            "Choose a channel to finish its account authorization. You can also keep chatting here."
          )
          .okouSectionNote()
        }
      case .capabilities: OnboardingCapabilitiesContent(store: store)
      case .ready: OnboardingReadyContent(store: store)
      }
    }
    .listSectionSpacing(OkouSpace.lg)
    .okouGroupedBackground()
    .scrollDismissesKeyboard(.interactively)
    .id(store.step)
    .disabled(store.isWorking)
  }

  private var footer: some View {
    VStack(spacing: OkouSpace.sm) {
      if let error = store.error {
        Text(error).font(.okou(.footnote)).foregroundStyle(OkouColor.destructive)
          .accessibilityAddTraits(.updatesFrequently)
      }
      Button {
        Task { await store.next() }
      } label: {
        ChatSettingsActionLabel(
          title: store.step == .ready ? "Open in chat" : "Continue", isBusy: store.isWorking)
      }
      .buttonStyle(OkouButtonStyle(isPrimary: true))
      .disabled(!store.canContinue || store.isWorking)
      .accessibilityIdentifier("onboarding-continue")
      if store.step != .industry {
        Button(store.step == .ready ? "Explore on my own" : "Not now") {
          Task { await store.next(skip: true) }
        }
        .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        .disabled(store.isWorking)
        .accessibilityIdentifier("onboarding-skip")
      }
    }
    .padding(.horizontal, OkouControl.pageInset)
    .padding(.vertical, OkouSpace.md)
    .background(OkouColor.background)
  }
}

extension OnboardingStep {
  var title: LocalizedStringKey {
    switch self {
    case .industry: "What kind of work do you do?"
    case .sources: "Give Okou some context"
    case .experience: "Bring your AI subscription"
    case .skills: "Bring your skills"
    case .slack: "Where would you like to chat?"
    case .capabilities: "Choose what Okou can do"
    case .ready: "Your first task"
    }
  }
  var detail: LocalizedStringKey {
    switch self {
    case .industry: "We'll tailor your setup and first task to your work."
    case .sources: "Connect the services you work in. You stay in control of access."
    case .experience:
      "Already use Codex or Claude Code? Connect your account, or continue with Okou."
    case .skills:
      "Copy an import prompt into your coding assistant to bring your local skills to Okou."
    case .slack: "Use Okou in your team's tools, or keep the conversation in this app."
    case .capabilities: "Enable the tools you want. You can change these choices later in Settings."
    case .ready: "Try a suggested task, or write something of your own."
    }
  }
}
