import ChatData
import SwiftUI

struct ChatModelPickerButton: View {
  @Bindable var selection: ChatModelSelectionStore
  @State private var isPresented = false
  private var models: ChatModelStore { selection.models }
  private var isLoading: Bool { models.isLoading || selection.isBusy }
  private var hasError: Bool {
    models.error != nil || selection.error != nil
      || (models.configuration != nil && !selection.canSend && !isLoading)
  }
  private var accessibilityValue: String {
    guard let configuration = models.configuration else {
      return models.error == nil
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

  var body: some View {
    // Keep the entry mounted before metadata exists so its load task can start.
    Button {
      isPresented = true
    } label: {
      Image(systemName: "slider.horizontal.3")
        .font(.system(size: 19))
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .tint(.primary)
    .accessibilityIdentifier("chat-model-picker")
    .overlay(alignment: .topTrailing) {
      if hasError {
        Image(systemName: "exclamationmark.circle.fill").font(.caption2).foregroundStyle(.orange)
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
    }
    .task {
      await selection.open()
    }
  }
}

struct ChatModelPickerView: View {
  @Bindable var selection: ChatModelSelectionStore
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
        if let configuration = models.configuration {
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
                if let provider = PersonalSubscriptionType(rawValue: type) {
                  HStack {
                    SubscriptionBrandIcon(type: provider)
                    Text(providerTitle(provider))
                    Spacer()
                    if let account = subscriptions.accounts.first(where: {
                      $0.type == type && $0.isActive != false
                    }),
                      let window = account.limitingWindow, let remaining = window.remaining
                    {
                      HStack(spacing: 4) {
                        Text("\(remaining, specifier: "%.0f")% remaining")
                        Text("·")
                        Text(
                          account.limitingUsage?.id == "week"
                            ? LocalizedStringKey("Week") : LocalizedStringKey("5 hours"))
                      }
                      .font(.caption)
                    }
                  }
                } else {
                  Text("Okou credits")
                }
              }
              .textCase(nil)
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
                      !configuration.canLinkSubscriptions || subscriptions.isLoading
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
          let efforts = configuration.efforts(for: selection.selection)
          if !efforts.isEmpty || configuration.canUseFast(selection.selection) {
            Section {
              if !efforts.isEmpty, let effectiveEffort = selection.effectiveEffort {
                Picker(
                  selection: Binding(
                    get: { effectiveEffort },
                    set: { value in
                      Task { await save(.effort) { await selection.choose(effort: value) } }
                    })
                ) {
                  ForEach(efforts, id: \.self) { Text(effortLabel($0)).tag($0) }
                } label: {
                  HStack(spacing: 8) {
                    Text("Thinking effort")
                    if selection.isSaving && pendingChange == .effort {
                      ProgressView().controlSize(.small)
                    }
                  }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("chat-model-effort")
                .disabled(selection.isBusy || selection.uncertain)
              }
              if configuration.canUseFast(selection.selection) {
                Toggle(
                  isOn: Binding(
                    get: { selection.selection.serviceTier == "priority" },
                    set: { fast in
                      Task { await save(.fast) { await selection.setFast(fast) } }
                    })
                ) {
                  HStack(spacing: 8) {
                    Label("Fast mode", systemImage: "bolt.fill")
                    if selection.isSaving && pendingChange == .fast {
                      ProgressView().controlSize(.small)
                    }
                  }
                }
                .tint(.green)
                .accessibilityIdentifier("chat-model-fast")
                .disabled(selection.isBusy || selection.uncertain)
              }
            } footer: {
              VStack(alignment: .leading, spacing: 6) {
                if !efforts.isEmpty {
                  HStack {
                    Text("Faster · lower usage")
                    Spacer()
                    Text("Smarter · higher usage")
                  }
                }
                if configuration.canUseFast(selection.selection) {
                  if let multiplier = configuration.catalog.fastMultiplier(
                    selection.selection.model),
                    configuration.row(for: selection.selection)?.memberEffective.runtimeProviderType
                      == "codex-oauth-token"
                  {
                    Text(
                      "Uses \(multiplier, specifier: "%g")× your ChatGPT subscription allowance.")
                  } else {
                    Text("Uses more of your subscription allowance.")
                  }
                }
              }
            }
          }
          Section {
            if configuration.models.contains(where: { $0.selectedModel != nil }) {
              Button {
                Task { await save(.futureChats) { await selection.saveForFutureChats() } }
              } label: {
                HStack {
                  Text(
                    selection.savedDefault
                      ? LocalizedStringKey("Default saved")
                      : LocalizedStringKey("Use for future chats too"))
                  Spacer()
                  if selection.isSaving && pendingChange == .futureChats {
                    ProgressView().controlSize(.small)
                  } else if selection.savedDefault {
                    Image(systemName: "checkmark")
                  }
                }
              }
              .accessibilityIdentifier("save-model-default")
              .disabled(selection.isBusy || selection.uncertain)
            }
            if configuration.canLinkSubscriptions {
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
          } footer: {
            Text("Changes apply to this chat.")
          }
        }
        if let error = selection.error ?? models.error ?? subscriptions.error {
          Section {
            Text(error).foregroundStyle(.red)
            Button("Refresh model settings") {
              Task {
                await models.refresh()
                await selection.refresh()
              }
            }
            .disabled(selection.isBusy)
          }
        }
      }
      .listSectionSpacing(16)
      .overlay {
        if models.configuration == nil && models.error == nil && selection.error == nil {
          ChatSettingsLoadingView(title: "Loading models…")
        }
      }
      .navigationTitle("Chat models")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .task {
        if !models.isLoading && !selection.isLoading { await selection.open() }
      }
      .task { await subscriptions.refresh() }
      .sheet(isPresented: $showsAuth, onDismiss: subscriptions.cancelAuth) {
        SubscriptionAuthorizationView(store: subscriptions)
      }
    }
  }
  private func modelRow(_ row: AvailableRunModels.Model, configuration: ChatModelConfiguration)
    -> some View
  {
    Button {
      Task {
        await save(.model(row.selectedModel)) { await selection.choose(model: row.selectedModel) }
      }
    } label: {
      HStack(spacing: 10) {
        if let type = PersonalSubscriptionType(rawValue: row.memberEffective.providerType) {
          SubscriptionBrandIcon(type: type)
        } else {
          Image("OkouMark").renderingMode(.template).resizable().scaledToFit().frame(
            width: 20, height: 20)
        }
        VStack(alignment: .leading) {
          Text(configuration.catalog.name(row.selectedModel))
          if row.memberEffective.availability == "plan_restricted" {
            Text("Plan restricted").font(.caption).foregroundStyle(.secondary)
          }
          if row.memberEffective.availability == "reconnect_required" {
            Text("Reconnect required").font(.caption).foregroundStyle(.secondary)
          }
        }
        Spacer()
        if selection.isSaving && pendingChange == .model(row.selectedModel) {
          HStack(spacing: 6) {
            ProgressView().controlSize(.small)
            Text("Saving…").font(.caption).foregroundStyle(.secondary)
          }
        } else if row.selectedModel == selection.selection.model {
          Image(systemName: "checkmark")
        }
      }.frame(minHeight: 32).contentShape(Rectangle())
        .foregroundStyle(.primary)
    }
    .buttonStyle(.plain)
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
