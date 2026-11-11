import CCStateSwiftUI
import ChatData
import SwiftUI

/// The chat's model in the open composer, beside the mic: its name, its thinking effort (and
/// Fast) quieter, and a chevron (`OkouComposerValueLabel`). The composer presents the model
/// sheet, so the sheet stays open while the keyboard goes down under it.
struct ChatModelPickerButton: View {
  let selection: ChatModelSelectionStore
  let action: () -> Void

  var body: some View {
    StoreProvider(selection.models.stateStore) {
      ChatModelPickerButtonContent(selection: selection, action: action)
        .id(ObjectIdentifier(selection.models))
    }
  }
}

private struct ChatModelPickerButtonContent: View {
  @Bindable var selection: ChatModelSelectionStore
  let action: () -> Void
  @ResolvedValue private var resolvedConfiguration: ChatModelConfiguration?
  @LoadableStatus<ChatModelConfiguration> private var modelStatus: LoadableState

  init(selection: ChatModelSelectionStore, action: @escaping () -> Void) {
    self.selection = selection
    self.action = action
    _resolvedConfiguration = ResolvedValue(
      task: selection.models.configurationValue, keepLast: true)
    _modelStatus = LoadableStatus(task: selection.models.configurationValue)
  }

  // Keep the existing confirmed display when a refresh fails; the Task still exposes its error.
  private var configuration: ChatModelConfiguration? {
    resolvedConfiguration ?? models.configuration
  }
  private var modelError: String? {
    $resolvedConfiguration.error.map(ChatRequestFailure.message(for:))
  }
  private var models: ChatModelStore { selection.models }
  private var isLoading: Bool { modelStatus == .loading || selection.isBusy }
  private var hasError: Bool {
    modelError != nil || selection.error != nil
      || (configuration != nil && !selection.canSend && !isLoading)
  }
  private var accessibilityValue: String {
    guard let configuration else {
      return modelError == nil
        ? String(localized: "Loading model settings")
        : String(localized: "Model settings unavailable")
    }
    var parts = [configuration.catalog.name(selection.selection.model)]
    if let effort = selection.effectiveEffort { parts.append(effortLabel(effort)) }
    if selection.selection.serviceTier == "priority" {
      parts.append(String(localized: "Fast mode"))
    }
    if hasError { parts.append(String(localized: "Model settings need attention")) }
    return parts.joined(separator: " · ")
  }

  /// Effort and Fast after the name, quieter than it ("GPT 6.1 Sol High").
  private var detail: String? {
    var parts: [String] = []
    if let effort = selection.effectiveEffort { parts.append(effortLabel(effort)) }
    if selection.selection.serviceTier == "priority" { parts.append(String(localized: "Fast")) }
    if parts.isEmpty { return nil }
    return parts.joined(separator: " ")
  }

  var body: some View {
    Button(action: action) {
      OkouComposerValueLabel(
        title: configuration.map { $0.catalog.name(selection.selection.model) }
          ?? String(localized: "Model settings"),
        detail: detail)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("chat-model-picker")
    .overlay(alignment: .topTrailing) {
      if hasError {
        OkouIcon("circle-alert", size: OkouIconSize.badge).foregroundStyle(
          OkouStatusColor.warning
        )
        .accessibilityHidden(true)
      }
    }
    .accessibilityLabel("Model settings")
    .accessibilityValue(accessibilityValue)
    .accessibilityHint("Choose a model, thinking effort, or Fast mode for this chat")
    // The control and the sheet observe the same workspace Task as the send checks.
  }
}

/// The model sheet; it sets its own detents, so every place that opens it gets the same height.
struct ChatModelPickerView: View {
  let selection: ChatModelSelectionStore
  /// A way to the full model settings on the web, for sheets opened from a failed reply.
  var settingsURL: URL?

  var body: some View {
    StoreProvider(selection.models.stateStore) {
      ChatModelPickerContent(selection: selection, settingsURL: settingsURL)
        .id(ObjectIdentifier(selection.models))
    }
  }
}

/// The model sheet, after ChatGPT's Configure sheet: a short form with the model, its thinking
/// effort and its speed, Set as default as a text action of its own, and Done. The Model row
/// opens every model listed by company, since several companies' models would crowd one menu;
/// picking one returns to the form. Choices are a draft until Done saves them together, so the
/// chat never runs on a half-made choice and nothing changes behind the sheet; ✕ or a swipe
/// drops it.
private struct ChatModelPickerContent: View {
  @Bindable var selection: ChatModelSelectionStore
  let settingsURL: URL?
  @ResolvedValue private var resolvedConfiguration: ChatModelConfiguration?
  @LoadableStatus<ChatModelConfiguration> private var modelStatus: LoadableState

  init(selection: ChatModelSelectionStore, settingsURL: URL?) {
    self.selection = selection
    self.settingsURL = settingsURL
    _resolvedConfiguration = ResolvedValue(
      task: selection.models.configurationValue, keepLast: true)
    _modelStatus = LoadableStatus(task: selection.models.configurationValue)
  }

  // Keep the existing confirmed display when a refresh fails; the Task still exposes its error.
  private var configuration: ChatModelConfiguration? {
    resolvedConfiguration ?? models.configuration
  }
  private var modelError: String? {
    $resolvedConfiguration.error.map(ChatRequestFailure.message(for:))
  }
  @Environment(\.dismiss) private var dismiss
  private var models: ChatModelStore { selection.models }
  private var subscriptions: PersonalSubscriptionStore { models.subscriptions }
  @State private var showsAuth = false
  /// The sheet's choice until Done saves it; nil follows the chat's saved choice.
  @State private var draft: ChatModelSelection?
  @State private var committing: Commit?
  @State private var commits = 0
  @State private var path: [Page] = []

  private enum Commit {
    case done
    case defaultForNewChats
  }

  private enum Page: Hashable {
    case models
  }

  private var choice: ChatModelSelection { draft ?? selection.selection }
  private var hasChanges: Bool {
    guard let configuration else { return false }
    return configuration.resolved(choice) != selection.selection
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let configuration {
          if selection.uncertain || modelError != nil {
            Section {
              refreshButton
            }
          }
          options(configuration)
          availabilityNotice(configuration)
          if selection.canSaveForFutureChats(choice) {
            defaultSection
          }
          if let settingsURL {
            Section { Link("Open model settings", destination: settingsURL) }
          }
        } else if let error = selection.error ?? modelError {
          Section {
            Text(error).foregroundStyle(OkouColor.destructive)
            refreshButton
          }
        }
      }
      .okouGroupedBackground()
      .listSectionSpacing(OkouSpace.lg)
      .overlay {
        if configuration == nil && modelError == nil && selection.error == nil {
          ChatSettingsLoadingView(title: "Loading models…")
        }
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if configuration != nil { doneBar }
      }
      .navigationTitle("Model settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        OkouCloseToolbarItem { dismiss() }
      }
      .navigationDestination(for: Page.self) { _ in
        if let configuration { modelList(configuration) }
      }
      .task {
        if modelStatus != .loading && !selection.isLoading { await selection.open() }
      }
    }
    .sheet(isPresented: $showsAuth, onDismiss: subscriptions.cancelAuth) {
      SubscriptionAuthorizationView(store: subscriptions)
    }
    // Half height on both pages, so the model list slides in where the form was; a drag (or
    // scrolling the list) takes the sheet to full height.
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .okouSheetBackground()
    .sensoryFeedback(.selection, trigger: commits)
  }

  private var refreshButton: some View {
    Button("Refresh model settings") {
      Task {
        await models.refresh()
        await selection.refresh()
      }
    }
    .disabled(selection.isBusy)
  }

  /// The drafted model, which opens the model list, then its thinking effort and speed as
  /// value menus. Fast's cost heads its menu, as a menu shows one line per option.
  private func options(_ configuration: ChatModelConfiguration) -> some View {
    let efforts = configuration.efforts(for: choice)
    let effort = configuration.effectiveEffort(for: choice)
    return Section {
      NavigationLink(value: Page.models) {
        OkouValueRow(value: Text(verbatim: configuration.catalog.name(choice.model))) {
          Text("Model")
        }
      }
      .accessibilityIdentifier("chat-model-list")
      if !efforts.isEmpty, let effort {
        Picker(
          selection: Binding(
            get: { effort },
            set: { draft = choice.choosing(effort: $0, in: configuration) })
        ) {
          ForEach(efforts, id: \.self) { Text(effortLabel($0)).tag($0) }
        } label: {
          Text("Thinking effort")
        }
        .okouValuePicker()
        .accessibilityIdentifier("chat-model-effort")
      }
      if configuration.canUseFast(choice) {
        Picker(
          selection: Binding(
            get: { choice.serviceTier == "priority" },
            set: { draft = choice.choosing(fast: $0, in: configuration) })
        ) {
          Section(fastNote(configuration)) {
            Text("Standard").tag(false)
            Text("Fast").tag(true)
          }
        } label: {
          Text("Speed")
        }
        .okouValuePicker()
        .accessibilityIdentifier("chat-model-speed")
      }
    }
    .disabled(committing != nil)
  }

  /// A new chat's choice can become the default too: a commit of its own, in `brand-text`
  /// so it reads apart from the options above it, as ChatGPT tints its Reset.
  private var defaultSection: some View {
    Section {
      Button {
        Task { await commit(.defaultForNewChats) }
      } label: {
        HStack {
          Text("Set as default for new chats").foregroundStyle(OkouColor.brandText)
          Spacer()
          if committing == .defaultForNewChats {
            ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
          }
        }
        .contentShape(Rectangle())
      }
      .disabled(committing != nil || selection.isBusy || selection.uncertain)
      .accessibilityIdentifier("save-model-default")
    }
  }

  /// Pinned under the form so Done stays in reach at any height, with the last save's error
  /// above it.
  private var doneBar: some View {
    VStack(spacing: OkouSpace.md) {
      if let error = selection.error ?? modelError {
        Text(error)
          .font(.okou(.footnote))
          .foregroundStyle(OkouColor.destructive)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      Button {
        Task { await commit(.done) }
      } label: {
        if committing == .done {
          ProgressView().tint(OkouColor.primaryForeground)
        } else {
          Text("Done")
        }
      }
      .buttonStyle(OkouButtonStyle(isPrimary: true))
      .disabled(committing != nil || hasChanges && (selection.isBusy || selection.uncertain))
      .accessibilityIdentifier("chat-model-done")
    }
    .padding(.horizontal, OkouSpace.lg)
    .padding(.vertical, OkouSpace.sm)
    .background(OkouGroupedColor.background)
  }

  /// Why the drafted model cannot run, under its options.
  @ViewBuilder
  private func availabilityNotice(_ configuration: ChatModelConfiguration) -> some View {
    if let row = configuration.row(for: choice) {
      if row.memberEffective.availability == "reconnect_required" {
        Section {
          Text("Reconnect your subscription to use this model.")
          if let type = PersonalSubscriptionType(rawValue: row.memberEffective.providerType) {
            Button("Reconnect") {
              Task { showsAuth = await subscriptions.reconnect(type: type) }
            }
            .disabled(
              !configuration.canLinkSubscriptions || subscriptions.isMutating || selection.isBusy)
          }
        }
      } else if row.memberEffective.availability != "available" {
        Section {
          Text("This model is restricted by your plan.")
          Link("Manage plan", destination: selection.modelsWebURL)
        }
      }
    } else {
      Section { Text("This model is unavailable. Choose an available model before sending.") }
    }
  }

  /// Every model, under its company's heading; picking one checks it and returns to the form.
  /// The sheet's half height can leave the checked model below, so the list opens with it in
  /// the middle; one near the top leaves the list at its top.
  private func modelList(_ configuration: ChatModelConfiguration) -> some View {
    ScrollViewReader { proxy in
      modelSections(configuration)
        .onAppear {
          if let checked = configuration.row(for: choice)?.id {
            proxy.scrollTo(checked, anchor: .center)
          }
        }
    }
    .navigationTitle("Chat models")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      OkouCloseToolbarItem { dismiss() }
    }
  }

  private func modelSections(_ configuration: ChatModelConfiguration) -> some View {
    List {
      ForEach(["built-in"] + PersonalSubscriptionType.allCases.map(\.rawValue), id: \.self) {
        type in
        let rows = configuration.models.filter {
          ($0.selectedModel == nil ? "built-in" : $0.memberEffective.providerType) == type
        }
        if !rows.isEmpty {
          Section {
            ForEach(rows) { row in modelRow(row, configuration: configuration) }
            if rows.contains(where: { $0.memberEffective.availability == "plan_restricted" }) {
              Link("Manage plan", destination: selection.modelsWebURL)
            }
          } header: {
            // Allowance lives on the Subscriptions page; the header only names the provider.
            if let provider = PersonalSubscriptionType(rawValue: type) {
              HStack(spacing: OkouSpace.sm) {
                SubscriptionBrandIcon(type: provider)
                Text(providerTitle(provider))
              }
              .okouSectionHeader()
            }
          }
        }
      }
      if configuration.canLinkSubscriptions {
        subscriptionsSection(configuration)
      }
      if let error = subscriptions.error {
        Section {
          OkouLoadErrorRow(message: error) { _ = await subscriptions.refresh(force: true) }
        }
      }
    }
    .okouGroupedBackground()
    .listSectionSpacing(OkouSpace.lg)
  }

  private func subscriptionsSection(_ configuration: ChatModelConfiguration) -> some View {
    Section {
      ForEach(PersonalSubscriptionType.allCases) { type in
        if !configuration.models.contains(where: {
          $0.selectedModel != nil && $0.memberEffective.providerType == type.rawValue
        }) {
          Button {
            subscriptions.start(type: type)
            showsAuth = true
          } label: {
            Label {
              Text("Connect \(providerTitle(type))")
            } icon: {
              SubscriptionBrandIcon(type: type)
            }
          }
          .disabled(selection.isBusy)
        }
      }
      NavigationLink("Manage subscriptions") {
        PersonalSubscriptionsView(store: subscriptions)
      }
      .disabled(selection.isBusy)
    }
  }

  private func modelRow(_ row: AvailableRunModels.Model, configuration: ChatModelConfiguration)
    -> some View
  {
    let isChecked = row.selectedModel == choice.model
    return Button {
      draft = choice.choosing(model: row.selectedModel)
      path.removeAll()
    } label: {
      HStack(spacing: OkouSpace.ten) {
        VStack(alignment: .leading) {
          // Built-in models carry their billing source on the row; they have no provider
          // heading of their own.
          HStack(alignment: .firstTextBaseline, spacing: OkouSpace.sm) {
            Text(configuration.catalog.name(row.selectedModel))
            if PersonalSubscriptionType(rawValue: row.memberEffective.providerType) == nil {
              Text("Okou credits")
                .font(.okou(.subheadline))
                .foregroundStyle(OkouColor.mutedForeground)
            }
          }
          if row.memberEffective.availability == "plan_restricted" {
            Text("Plan restricted").font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
          }
          if row.memberEffective.availability == "reconnect_required" {
            Text("Reconnect required").font(.okou(.caption)).foregroundStyle(
              OkouColor.mutedForeground)
          }
        }
        Spacer()
        if isChecked { OkouIcon("check") }
      }
      // The whole row is the button: no system padding above or below, the label takes the
      // grouped row's height itself; the system keeps its side insets, so the text starts on
      // the same edge.
      .padding(.vertical, OkouSpace.sm)
      .frame(minHeight: OkouControl.groupedRow)
      .contentShape(Rectangle())
    }
    .buttonStyle(ModelChoiceButtonStyle())
    .listRowInsets(.vertical, 0)
    .disabled(!row.isConfigurable)
    .accessibilityIdentifier("chat-model-\(row.id)")
    .accessibilityAddTraits(isChecked ? [.isSelected] : [])
  }

  private func fastNote(_ configuration: ChatModelConfiguration) -> String {
    if let multiplier = configuration.catalog.fastMultiplier(choice.model),
      configuration.row(for: choice)?.memberEffective.runtimeProviderType == "codex-oauth-token"
    {
      return String(
        localized:
          "Fast mode uses \(multiplier, specifier: "%g")× your ChatGPT subscription allowance.")
    }
    return String(localized: "Fast mode uses more of your subscription allowance.")
  }

  /// Saves the draft; on success the sheet closes with a tap of haptic feedback and the
  /// composer's model control shows the new choice. A failure keeps the sheet and the draft,
  /// with the error above Done.
  private func commit(_ kind: Commit) async {
    guard committing == nil else { return }
    committing = kind
    defer { committing = nil }
    var saved = await selection.apply(choice)
    if saved && kind == .defaultForNewChats {
      saved = await selection.saveForFutureChats()
    }
    guard saved else { return }
    commits += 1
    dismiss()
  }
}

private struct ModelChoiceButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    // Keep the confirmed choices readable while conflicting mutations are disabled.
    configuration.label.opacity(configuration.isPressed ? 0.65 : 1)
  }
}

func effortLabel(_ effort: String) -> String {
  effort == "xhigh" ? "xHigh" : effort.prefix(1).uppercased() + effort.dropFirst()
}
func providerTitle(_ type: PersonalSubscriptionType) -> String {
  type == .codex ? "ChatGPT / Codex" : "Claude Code"
}
struct SubscriptionBrandIcon: View {
  let type: PersonalSubscriptionType
  var body: some View {
    Image(type == .codex ? "OpenAIMark" : "AnthropicMark")
      .renderingMode(.template).resizable().scaledToFit()
      .frame(width: 20, height: 20).accessibilityHidden(true)
  }
}
