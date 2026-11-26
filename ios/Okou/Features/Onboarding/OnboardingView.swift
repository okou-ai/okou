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
  @Environment(\.scenePhase) private var scenePhase
  @LoadableValue private var status: Loadable<OnboardingStatus>
  @ResolvedValue private var resolvedState: OnboardingStore.Snapshot?

  init(store: OnboardingStore, needsUpgrade: Bool, content: @escaping () -> Content) {
    self.store = store
    self.needsUpgrade = needsUpgrade
    self.content = content
    _status = LoadableValue(task: store.resources.status, keepLast: true)
    _resolvedState = ResolvedValue(store.value)
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
            if store.canSignOut {
              Button("Sign out") { Task { await store.signOut() } }
                .buttonStyle(OkouButtonStyle(isPrimary: false))
            }
          }
        case .hasData(let value):
          if value.presentsOnboarding
            || (resolvedState?.task != nil && resolvedState?.didFinish != true)
          {
            OnboardingView(store: store)
          } else {
            content()
          }
        }
      }
    }
    .background(OkouColor.background.ignoresSafeArea())
    .onChange(of: scenePhase) { _, phase in
      if phase == .active, status.data?.presentsOnboarding == true, !store.snapshot.isWorking,
        store.snapshot.task == nil
      {
        store.retry(.status)
      }
    }
  }

  private func retryStatus() {
    store.retry(.status)
  }
}

struct OnboardingView: View {
  let store: OnboardingStore
  @ResolvedValue private var resolvedState: OnboardingStore.Snapshot?
  @ResolvedValue private var resolvedConnectors: ComposerConnectorStore.Snapshot?
  @State private var confirmsSignOut = false
  @Environment(\.scenePhase) private var scenePhase

  init(store: OnboardingStore) {
    self.store = store
    _resolvedState = ResolvedValue(store.value)
    _resolvedConnectors = ResolvedValue(store.connectors.snapshotValue)
  }

  private var state: OnboardingStore.Snapshot { resolvedState ?? store.snapshot }

  var body: some View {
    NavigationStack {
      Group {
        if state.isPrepared {
          stepContent
        } else if let error = state.error {
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
          if state.stepIndex > 0, state.task == nil {
            Button("Back", okouSymbol: "chevron-left") { Task { await store.back() } }
              .disabled(state.isWorking)
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            if store.canSignOut {
              Button("Sign out", role: .destructive) { confirmsSignOut = true }
            }
          } label: {
            Text("\(state.stepIndex + 1) of \(OnboardingStore.Snapshot.steps.count)")
              .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
              .accessibilityLabel(
                "Step \(state.stepIndex + 1) of \(OnboardingStore.Snapshot.steps.count), account options"
              )
          }
        }
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if state.isPrepared { footer }
      }
      .connectorAuthorizationPresentation(store: store.connectors)
      .signOutConfirmation(isPresented: $confirmsSignOut) {
        Task { await store.signOut() }
      }
    }
    .task {
      store.startLiveUpdates()
      await store.prepare()
    }
    .onDisappear { store.endPresentation() }
    .onChange(of: scenePhase) { _, phase in
      store.setForeground(phase == .active)
      if phase == .active, state.step == .ready { Task { await store.refreshReady() } }
      if phase == .active, state.step == .sources { Task { await store.connectors.refresh() } }
    }
  }

  private var stepContent: some View {
    List {
      Section {
        VStack(alignment: .leading, spacing: OkouSpace.md) {
          Text(state.step.title).font(.okou(.title).weight(.semibold))
            .accessibilityAddTraits(.isHeader)
          Text(state.step.detail).font(.okou(.subheadline))
            .foregroundStyle(OkouColor.mutedForeground)
        }
        .padding(.vertical, OkouSpace.md)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      }
      switch state.step {
      case .industry: OnboardingIndustryContent(store: store)
      case .sources:
        OnboardingSourcesContent(store: store)
      case .ready: OnboardingReadyContent(store: store)
      }
    }
    .listSectionSpacing(OkouSpace.lg)
    .okouGroupedBackground()
    .scrollDismissesKeyboard(.interactively)
    .id(state.step)
    .disabled(state.isWorking)
  }

  private var footer: some View {
    VStack(spacing: OkouSpace.sm) {
      if let error = state.error {
        Text(error).font(.okou(.footnote)).foregroundStyle(OkouColor.destructive)
          .accessibilityAddTraits(.updatesFrequently)
      }
      if state.hasDraftConflict {
        Button("Reload saved setup") { Task { await store.retryPreparation() } }
          .buttonStyle(OkouButtonStyle(isPrimary: false))
          .disabled(state.isWorking)
          .accessibilityIdentifier("onboarding-reload")
      }
      Button {
        Task { await store.next() }
      } label: {
        ChatSettingsActionLabel(
          title: state.step == .ready ? "Confirm and run" : "Continue", isBusy: state.isWorking)
      }
      .buttonStyle(OkouButtonStyle(isPrimary: true))
      .disabled(
        !state.canContinue(
          connected: !(resolvedConnectors ?? store.connectors.snapshot).connectors.isEmpty)
          || state.isWorking || state.hasDraftConflict
      )
      .accessibilityIdentifier("onboarding-continue")
      Button(state.step == .ready ? "Explore on my own" : "Not now") {
        Task { await store.next(skip: true) }
      }
      .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
      .disabled(state.isWorking || state.hasDraftConflict || state.task != nil)
      .accessibilityIdentifier("onboarding-skip")
    }
    .padding(.horizontal, OkouControl.pageInset)
    .padding(.vertical, OkouSpace.md)
    .background(OkouColor.background)
  }
}

extension NativeOnboardingStep {
  var title: LocalizedStringKey {
    switch self {
    case .industry: "What's your role?"
    case .sources: "Connect your services"
    case .ready: "Your first task"
    }
  }
  var detail: LocalizedStringKey {
    switch self {
    case .industry: "We'll suggest a first task that fits your work."
    case .sources: "Connect the services you work in. You stay in control of access."
    case .ready: "Review the suggested task or write your own, then confirm to run it."
    }
  }
}
