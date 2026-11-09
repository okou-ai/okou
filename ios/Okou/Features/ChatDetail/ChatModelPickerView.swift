import CCStateSwiftUI
import ChatData
import SwiftUI

/// The chat's model, in the header beside the menu as Kimi and ChatGPT place it: a glass
/// capsule the height of the other header controls with the model's name in the text colour
/// and its thinking effort (and Fast) in supporting grey. It opens the model sheet.
struct ChatModelPickerButton: View {
  let selection: ChatModelSelectionStore

  var body: some View {
    StoreProvider(selection.models.stateStore) {
      ChatModelPickerButtonContent(selection: selection)
        .id(ObjectIdentifier(selection.models))
    }
  }
}

private struct ChatModelPickerButtonContent: View {
  @Bindable var selection: ChatModelSelectionStore
  @ResolvedValue private var resolvedConfiguration: ChatModelConfiguration?
  @LoadableStatus<ChatModelConfiguration> private var modelStatus: LoadableState

  init(selection: ChatModelSelectionStore) {
    self.selection = selection
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
  @State private var isPresented = false
  @Environment(\.newChatActivation) private var newChatActivation
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
    Button {
      isPresented = true
    } label: {
      HStack(spacing: OkouSpace.six) {
        Text(
          configuration.map { $0.catalog.name(selection.selection.model) }
            ?? String(localized: "Model settings")
        )
        .font(.okou(.callout).weight(.medium))
        .foregroundStyle(OkouColor.foreground)
        if let detail {
          Text(verbatim: detail)
            .font(.okou(.callout))
            .foregroundStyle(OkouColor.mutedForeground)
        }
      }
      .lineLimit(1)
      .padding(.horizontal, OkouSpace.lg)
      .modifier(OkouGlassControl(shape: .capsule))
    }
    .buttonStyle(.plain)
    .tint(OkouColor.foreground)
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
    .sheet(isPresented: $isPresented) {
      ChatModelPickerView(selection: selection)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .okouSheetBackground()
    }
    .onChange(of: newChatActivation) { _, _ in isPresented = false }
    // The capsule and sheet observe the same workspace Task as the composer and send checks.
  }
}

struct ChatModelPickerView: View {
  let selection: ChatModelSelectionStore

  var body: some View {
    StoreProvider(selection.models.stateStore) {
      ChatModelPickerContent(selection: selection)
        .id(ObjectIdentifier(selection.models))
    }
  }
}

private struct ChatModelPickerContent: View {
  @Bindable var selection: ChatModelSelectionStore
  @ResolvedValue private var resolvedConfiguration: ChatModelConfiguration?
  @LoadableStatus<ChatModelConfiguration> private var modelStatus: LoadableState

  init(selection: ChatModelSelectionStore) {
    self.selection = selection
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
  @State private var pendingChange: PendingChange?

  private enum PendingChange: Equatable {
    case model(String?)
    case effort
    case fast
    case futureChats
  }

  var body: some View {
    NavigationStack {
      List {
        if let configuration {
          // Thinking effort and Fast mode belong to the selected model, so they sit in that
          // model's provider card; only when no listed model is selected do they stand alone.
          if selectedSectionType(configuration) == nil {
            let options = modelOptions(configuration)
            if options.hasAny {
              Section {
                modelOptionRows(configuration)
              } footer: {
                modelOptionsFooter(configuration).okouSectionNote()
              }
            }
          }
          if selection.canSaveForFutureChats {
            Section {
              Button {
                Task { await save(.futureChats) { await selection.saveForFutureChats() } }
              } label: {
                HStack {
                  Text("Set as default for new chats").foregroundStyle(OkouColor.foreground)
                  Spacer()
                  if selection.isSaving && pendingChange == .futureChats {
                    ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
                  }
                }
                .contentShape(Rectangle())
              }
              .accessibilityIdentifier("save-model-default")
              .disabled(selection.isBusy || selection.uncertain)
            } footer: {
              Text("Only this new chat uses these settings.").okouSectionNote()
            }
          }
          ForEach(["built-in"] + PersonalSubscriptionType.allCases.map(\.rawValue), id: \.self) {
            type in
            let rows = configuration.models.filter {
              ($0.selectedModel == nil ? "built-in" : $0.memberEffective.providerType) == type
            }
            if !rows.isEmpty {
              let holdsSelection = selectedSectionType(configuration) == type
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
              // The selected model's options get their own card right under its list: one
              // separator style per card, and still next to the models they configure.
              if holdsSelection && modelOptions(configuration).hasAny {
                Section {
                  modelOptionRows(configuration)
                } footer: {
                  modelOptionsFooter(configuration).okouSectionNote()
                }
                .listSectionSpacing(.compact)
              }
            }
          }
          if let row = configuration.row(for: selection.selection) {
            if row.memberEffective.availability != "available" {
              Section {
                if row.memberEffective.availability == "reconnect_required" {
                  Text("Reconnect your subscription to use this model.")
                  if let type = PersonalSubscriptionType(rawValue: row.memberEffective.providerType)
                  {
                    Button("Reconnect") {
                      Task { showsAuth = await subscriptions.reconnect(type: type) }
                    }
                    .disabled(
                      !configuration.canLinkSubscriptions || subscriptions.isMutating
                        || selection.isBusy)
                  }
                } else {
                  Text("This model is restricted by your plan.")
                  Link("Manage plan", destination: selection.modelsWebURL)
                }
              }
            }
          } else {
            Section { Text("This model is unavailable. Choose an available model before sending.") }
          }
          if configuration.canLinkSubscriptions {
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
        }
        if let error = selection.error ?? modelError {
          Section {
            Text(error).foregroundStyle(OkouColor.destructive)
            Button("Refresh model settings") {
              Task {
                await models.refresh()
                await selection.refresh()
              }
            }
            .disabled(selection.isBusy)
          }
        }
        if let error = subscriptions.error {
          Section {
            OkouLoadErrorRow(message: error) { _ = await subscriptions.refresh(force: true) }
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
      .navigationTitle("Chat models")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        OkouCloseToolbarItem { dismiss() }
      }
      .task {
        if modelStatus != .loading && !selection.isLoading { await selection.open() }
      }
      .sheet(isPresented: $showsAuth, onDismiss: subscriptions.cancelAuth) {
        SubscriptionAuthorizationView(store: subscriptions)
      }
    }
  }
  /// The provider section ("built-in" or a subscription type) that lists the selected model.
  private func selectedSectionType(_ configuration: ChatModelConfiguration) -> String? {
    guard let row = configuration.row(for: selection.selection) else { return nil }
    return row.selectedModel == nil ? "built-in" : row.memberEffective.providerType
  }

  private struct ModelOptions {
    let efforts: [String]
    let effort: String?
    let fast: Bool
    var hasAny: Bool { (!efforts.isEmpty && effort != nil) || fast }
  }

  private func modelOptions(_ configuration: ChatModelConfiguration) -> ModelOptions {
    ModelOptions(
      efforts: configuration.efforts(for: selection.selection), effort: selection.effectiveEffort,
      fast: configuration.canUseFast(selection.selection))
  }

  @ViewBuilder
  private func modelOptionRows(_ configuration: ChatModelConfiguration) -> some View {
    let options = modelOptions(configuration)
    if !options.efforts.isEmpty, let effort = options.effort {
      Picker(
        selection: Binding(
          get: { effort },
          set: { value in
            Task { await save(.effort) { await selection.choose(effort: value) } }
          }
        )
      ) {
        ForEach(options.efforts, id: \.self) { Text(effortLabel($0)).tag($0) }
      } label: {
        HStack(spacing: OkouSpace.sm) {
          Text("Thinking effort")
          if selection.isSaving && pendingChange == .effort {
            ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
          }
        }
      }
      .okouValuePicker()
      .accessibilityIdentifier("chat-model-effort")
      .disabled(selection.isBusy || selection.uncertain)
    }
    if options.fast {
      Toggle(
        isOn: Binding(
          get: { selection.selection.serviceTier == "priority" },
          set: { fast in Task { await save(.fast) { await selection.setFast(fast) } } }
        )
      ) {
        HStack(spacing: OkouSpace.sm) {
          Text("Fast mode")
          if selection.isSaving && pendingChange == .fast {
            ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
          }
        }
      }
      .tint(OkouColor.primary400)
      .accessibilityIdentifier("chat-model-fast")
      .disabled(selection.isBusy || selection.uncertain)
    }
  }

  /// One explanation under the card, as the system Settings app places it.
  @ViewBuilder
  private func modelOptionsFooter(_ configuration: ChatModelConfiguration) -> some View {
    if let note = modelOptionsNote(configuration) { Text(note) }
  }

  private func modelOptionsNote(_ configuration: ChatModelConfiguration) -> String? {
    let options = modelOptions(configuration)
    var notes: [String] = []
    if !options.efforts.isEmpty && options.effort != nil {
      notes.append(
        String(localized: "Higher effort thinks longer and uses more of your allowance."))
    }
    if options.fast {
      if let multiplier = configuration.catalog.fastMultiplier(selection.selection.model),
        configuration.row(for: selection.selection)?.memberEffective.runtimeProviderType
          == "codex-oauth-token"
      {
        notes.append(
          String(
            localized:
              "Fast mode uses \(multiplier, specifier: "%g")× your ChatGPT subscription allowance."
          ))
      } else {
        notes.append(String(localized: "Fast mode uses more of your subscription allowance."))
      }
    }
    return notes.isEmpty ? nil : notes.joined(separator: " ")
  }

  private func modelRow(_ row: AvailableRunModels.Model, configuration: ChatModelConfiguration)
    -> some View
  {
    Button {
      Task {
        await save(.model(row.selectedModel)) { await selection.choose(model: row.selectedModel) }
      }
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
        if selection.isSaving && pendingChange == .model(row.selectedModel) {
          ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
        } else if row.selectedModel == selection.selection.model {
          OkouIcon("check")
        }
      }
      // The whole row is the button: no system padding above or below, the label takes the
      // grouped row's height itself, so a model row is as tall as Thinking effort under it;
      // the system keeps its side insets, so the text starts on the same edge.
      .padding(.vertical, OkouSpace.sm)
      .frame(minHeight: OkouControl.groupedRow)
      .contentShape(Rectangle())
    }
    .buttonStyle(ModelChoiceButtonStyle())
    .listRowInsets(.vertical, 0)
    .disabled(!row.isConfigurable || selection.isBusy || selection.uncertain)
    .accessibilityIdentifier("chat-model-\(row.id)")
    .accessibilityAddTraits(row.selectedModel == selection.selection.model ? [.isSelected] : [])
  }

  private func save(_ change: PendingChange, operation: @MainActor () async -> Void) async {
    guard !selection.isBusy, !selection.uncertain else { return }
    pendingChange = change
    defer { pendingChange = nil }
    await operation()
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
