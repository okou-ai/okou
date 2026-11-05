import ChatData
import SwiftUI

struct ChatModelPickerButton: View {
  @Bindable var selection: ChatModelSelectionStore
  var showsName = false
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
        if showsName {
          HStack(spacing: OkouSpace.xs) {
            Text(
              models.configuration.map { $0.catalog.name(selection.selection.model) }
                ?? String(localized: "Model settings")
            )
            // One step under the 17 pt message text: readable, still clearly a control.
            .font(.okou(.callout))
            .lineLimit(1)
            OkouIcon("chevron-down", size: OkouIconSize.accessory)
          }
          .padding(.horizontal, OkouSpace.sm)
          .frame(minHeight: OkouControl.minimumTarget)
        } else {
          OkouToolbarIcon("sliders-horizontal")
            .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
        }
      }.contentShape(Rectangle())
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
          if selection.isSaving {
            OkouLoadingRow("Saving model settings…")
          } else if selection.isLoading {
            OkouLoadingRow("Loading model settings…")
          }
          // Thinking effort and Fast mode belong to the selected model, so they sit in that
          // model's provider card; only when no listed model is selected do they stand alone.
          if selectedSectionType(configuration) == nil {
            let options = modelOptions(configuration)
            if options.hasAny {
              Section {
                modelOptionRows(configuration)
              } footer: {
                Group {
                  modelOptionsFooter(configuration)

                }
                .okouSectionNote()
              }
            }
          }
          if configuration.models.contains(where: { $0.selectedModel != nil }) {
            Section {
              // An ordinary action row, like Settings' rows: amber is for the primary commit.
              if selection.savedDefault {
                HStack {
                  Text("Default for new chats")
                  Spacer()
                  OkouIcon("check", size: OkouIconSize.inline)
                }
                .foregroundStyle(OkouColor.mutedForeground)
              } else {
                Button {
                  Task { await selection.saveForFutureChats() }
                } label: {
                  Text("Use for new chats too")
                    .foregroundStyle(OkouColor.foreground)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .accessibilityIdentifier("save-model-default")
                .disabled(selection.uncertain)
              }
            } footer: {
              Group {
                Text("Changes apply to this chat right away.")

              }
              .okouSectionNote()
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
          OkouLoadingRow("Loading models…")
        }
        if let error = selection.error ?? models.error ?? subscriptions.error {
          Section {
            Text(error).foregroundStyle(OkouColor.destructive)
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
      .okouGroupedBackground()
      .navigationTitle("Chat models")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { OkouCloseButton { dismiss() } }
      }
      .task {
        if !models.isLoading && !selection.isLoading { await selection.open() }
      }
      .task { await subscriptions.refresh() }
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
          set: { value in Task { await selection.choose(effort: value) } }
        )
      ) {
        ForEach(options.efforts, id: \.self) { Text(effortLabel($0)).tag($0) }
      } label: {
        Text("Thinking effort")
      }
      .okouValuePicker()
      .accessibilityIdentifier("chat-model-effort")
      .disabled(selection.uncertain)
    }
    if options.fast {
      Toggle(
        isOn: Binding(
          get: { selection.selection.serviceTier == "priority" },
          set: { fast in Task { await selection.setFast(fast) } }
        )
      ) {
        Text("Fast mode")
      }
      .tint(OkouColor.primary400)
      .accessibilityIdentifier("chat-model-fast")
      .disabled(selection.uncertain)
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
      Task { await selection.choose(model: row.selectedModel) }
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
        if row.selectedModel == selection.selection.model { OkouIcon("check") }
      }.contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!row.isConfigurable || selection.uncertain)
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
