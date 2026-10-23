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
      Group {
        if isLoading {
          ProgressView().controlSize(.small)
        } else {
          Image(systemName: hasError ? "exclamationmark.circle" : "slider.horizontal.3")
        }
      }
      .font(.system(size: 16, weight: .medium))
      .frame(width: 22, height: 22)
    }
    .buttonStyle(.glass)
    .buttonBorderShape(.circle)
    .controlSize(.small)
    .tint(hasError ? .orange : .primary)
    .frame(width: 44, height: 44)
    .contentShape(Circle())
    .accessibilityIdentifier("chat-model-picker")
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
                      VStack(alignment: .trailing) {
                        Text("\(remaining, specifier: "%.0f")% remaining")
                        Text(
                          account.limitingUsage?.id == "week"
                            ? LocalizedStringKey("Week") : LocalizedStringKey("5 hours"))
                      }
                    }
                  }
                } else {
                  Text("Okou credits")
                }
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
                    }.disabled(!configuration.canLinkSubscriptions || subscriptions.isLoading)
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
          if !efforts.isEmpty, let effectiveEffort = selection.effectiveEffort {
            Section {
              Picker(
                "Thinking effort",
                selection: Binding(
                  get: { effectiveEffort },
                  set: { value in Task { await selection.choose(effort: value) } }
                )
              ) {
                ForEach(efforts, id: \.self) { Text(effortLabel($0)).tag($0) }
              }
              .pickerStyle(.menu)
              .accessibilityIdentifier("chat-model-effort")
              HStack {
                Text("Faster · lower usage")
                Spacer()
                Text("Smarter · higher usage")
              }.font(.caption).foregroundStyle(.secondary)
            }
          }
          if configuration.canUseFast(selection.selection) {
            Section {
              Toggle(
                isOn: Binding(
                  get: { selection.selection.serviceTier == "priority" },
                  set: { fast in Task { await selection.setFast(fast) } }
                )
              ) {
                Label("Fast mode", systemImage: "bolt.fill")
              }
              .tint(.green)
              .accessibilityIdentifier("chat-model-fast")
              if let multiplier = configuration.catalog.fastMultiplier(selection.selection.model),
                configuration.row(for: selection.selection)?.memberEffective.runtimeProviderType
                  == "codex-oauth-token"
              {
                Text("Uses \(multiplier, specifier: "%g")× your ChatGPT subscription allowance.")
                  .font(.caption).foregroundStyle(.secondary)
              } else {
                Text("Uses more of your subscription allowance.").font(.caption).foregroundStyle(
                  .secondary)
              }
            }
          }
          if configuration.models.contains(where: { $0.selectedModel != nil }) {
            Section {
              Text("Changes apply to this chat.")
              Button("Use for future chats too") { Task { await selection.saveForFutureChats() } }
                .accessibilityIdentifier("save-model-default")
              if selection.savedDefault { Label("Default saved", systemImage: "checkmark") }
            }
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
                }
              }
              NavigationLink("Manage subscriptions") {
                PersonalSubscriptionsView(store: subscriptions)
              }
            }
          }
        } else if models.isLoading {
          ProgressView("Loading models…")
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
          }
        }
      }
      .disabled(selection.isBusy)
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
      Task { await selection.choose(model: row.selectedModel) }
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
        if row.selectedModel == selection.selection.model { Image(systemName: "checkmark") }
      }.frame(minHeight: 32).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!row.isConfigurable)
    .accessibilityIdentifier("chat-model-\(row.id)")
    .accessibilityAddTraits(row.selectedModel == selection.selection.model ? [.isSelected] : [])
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
