import CCStateSwiftUI
import ChatData
import SwiftUI

struct PermissionBatchCard: View {
  let store: PermissionBatchStore
  let loadsState: Bool

  var body: some View {
    StoreProvider(store.resource.store) {
      PermissionBatchCardContent(store: store, loadsState: loadsState)
    }
  }
}

private struct PermissionBatchCardContent: View {
  @Bindable var store: PermissionBatchStore
  let loadsState: Bool
  @Environment(\.scenePhase) private var scenePhase
  @State private var showsDetails = false
  @LoadableValue private var page: Loadable<ChatPermissionBatchSnapshot>

  init(store: PermissionBatchStore, loadsState: Bool) {
    self.store = store
    self.loadsState = loadsState
    _page = LoadableValue(task: loadsState ? store.resource.value : store.resource.unrequested)
  }

  private var snapshot: ChatPermissionBatchSnapshot? {
    if case .hasData(let value) = page { return value }
    return store.unconfirmedSnapshot
  }
  private var isLoading: Bool {
    if case .loading = page { return true }
    return false
  }
  private var error: String? {
    if case .hasError(let error) = page, !(error is CancellationError) {
      return ChatRequestFailure.message(for: error)
    }
    return store.error
  }
  private var requiresReadback: Bool {
    if case .hasError = page { return true }
    return store.requiresReadback
  }
  private var allAllowed: Bool { snapshot?.allAllowed == true && !requiresReadback }
  private var needsContinuation: Bool {
    allAllowed && snapshot.map(store.needsContinuation) == true
  }
  private var canConfirm: Bool {
    !isLoading && !requiresReadback && snapshot.map(store.canConfirm) == true
  }

  private var status: String {
    if store.isContinuing { return String(localized: "Continuing chat…") }
    if store.isSaving { return String(localized: "Saving permissions…") }
    if isLoading { return String(localized: "Checking permissions…") }
    if requiresReadback { return String(localized: "Check permission status") }
    guard let snapshot = snapshot else {
      return String(localized: "Checking permissions…")
    }
    if !snapshot.complete { return String(localized: "Permission request unavailable") }
    if store.hasContinued && allAllowed {
      return String(localized: "Permissions allowed · Chat continued")
    }
    if needsContinuation {
      return String(localized: "Permissions allowed · Continue chat")
    }
    return String(
      localized: "\(snapshot.allowedCount) of \(store.action.items.count) permissions allowed")
  }

  var body: some View {
    ChatActionCard {
      ChatCardHeader(title: String(localized: "Permissions requested"), icon: "shield-check") {
        Text(
          "\(Set(store.action.items.map(\.connectorSlug)).count) services · \(store.action.items.count) permissions"
        )
        Text(status).font(.caption).lineLimit(1, reservesSpace: true)
      }
    } actions: {
      Button {
        showsDetails = true
      } label: {
        if allAllowed && !needsContinuation {
          Label("View details", systemImage: "checkmark.circle")
        } else if needsContinuation {
          Text("Continue chat")
        } else {
          Text("Review permissions")
        }
      }
      .accessibilityIdentifier("permission-batch-review")
    }
    .accessibilityIdentifier("permission-batch-card")
    .sheet(isPresented: $showsDetails) {
      PermissionBatchDetails(store: store)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active && store.isActive && loadsState {
        Task { await store.refresh() }
      }
    }
  }
}

struct PermissionBatchDetails: View {
  let store: PermissionBatchStore

  var body: some View {
    StoreProvider(store.resource.store) { PermissionBatchDetailsContent(store: store) }
  }
}

private struct PermissionBatchDetailsContent: View {
  @Bindable var store: PermissionBatchStore
  @Environment(\.dismiss) private var dismiss
  @LoadableValue private var page: Loadable<ChatPermissionBatchSnapshot>

  init(store: PermissionBatchStore) {
    self.store = store
    _page = LoadableValue(task: store.resource.value)
  }

  private var snapshot: ChatPermissionBatchSnapshot? {
    if case .hasData(let value) = page { return value }
    return store.unconfirmedSnapshot
  }
  private var isLoading: Bool {
    if case .loading = page { return true }
    return false
  }
  private var error: String? {
    if case .hasError(let error) = page, !(error is CancellationError) {
      return ChatRequestFailure.message(for: error)
    }
    return store.error
  }
  private var requiresReadback: Bool {
    if case .hasError = page { return true }
    return store.requiresReadback
  }
  private var allAllowed: Bool { snapshot?.allAllowed == true && !requiresReadback }
  private var needsContinuation: Bool {
    allAllowed && snapshot.map(store.needsContinuation) == true
  }
  private var canConfirm: Bool {
    !isLoading && !requiresReadback && snapshot.map(store.canConfirm) == true
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          requestSummary
          if let snapshot = snapshot {
            if snapshot.enabled {
              Text(
                snapshot.connectorScoped
                  ? "These permissions apply to these connectors across your chats and accounts."
                  : "These permissions apply to your account for this Agent."
              )
              .font(.footnote).foregroundStyle(.secondary)
              ForEach(snapshot.groups) { group in
                PermissionBatchGroup(group: group, verifiesGrants: !requiresReadback)
              }
            } else {
              Text("Batch permissions are not available for your account right now.")
                .foregroundStyle(.secondary)
            }
          }
          if let error = error {
            Text(error).font(.footnote).foregroundStyle(.red).textSelection(.enabled)
          }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(Color(uiColor: .systemGroupedBackground))
      .safeAreaInset(edge: .bottom, spacing: 0) { confirmation }
      .navigationTitle("Permissions")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
      }
    }
    .task { await store.refresh() }
  }

  private var requestSummary: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: allAllowed ? "checkmark.shield" : "lock.shield")
        .font(.title3)
        .foregroundStyle(allAllowed ? Color.green : Color.secondary)
        .frame(width: 40, height: 40)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 6) {
        Text("\(store.action.items.count) permissions requested").font(.headline)
        Text("Requested by \(snapshot?.agentName ?? String(localized: "this Agent"))")
          .font(.subheadline).foregroundStyle(.secondary)
        if let snapshot = snapshot, snapshot.enabled && !requiresReadback {
          Text("\(snapshot.allowedCount) of \(store.action.items.count) permissions allowed")
            .font(.footnote).foregroundStyle(.secondary)
        }
        if store.hasContinued {
          Text("Your chat has continued.").font(.footnote).foregroundStyle(.secondary)
        } else if needsContinuation && error != nil {
          Text("Permissions allowed · Chat not continued")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }
    }
  }

  private var confirmation: some View {
    VStack(spacing: 12) {
      if isLoading && snapshot == nil {
        ProgressView("Checking permissions…").frame(minHeight: 44)
      } else if requiresReadback || snapshot == nil {
        if requiresReadback {
          Text("Check the current permissions before trying again.")
            .font(.footnote).foregroundStyle(.secondary)
        }
        Button("Check permissions") { Task { await store.refresh() } }
          .frame(minHeight: 44).disabled(isLoading || store.isSaving)
      } else if snapshot?.complete != true {
        Text("These permissions are no longer available.")
          .font(.footnote).foregroundStyle(.secondary)
      } else if allAllowed && !needsContinuation && !store.isSaving {
        Button("Done") { dismiss() }
          .buttonStyle(OkouButtonStyle(isPrimary: true))
      } else {
        if !allAllowed && !store.isContinuing {
          HStack {
            Text("Allow new permissions for").font(.subheadline)
            Spacer(minLength: 12)
            Picker("Allow new permissions for", selection: $store.duration) {
              Text("1 hour").tag(ChatPermissionAction.Duration.hour)
              Text("24 hours").tag(ChatPermissionAction.Duration.day)
              Text("7 days").tag(ChatPermissionAction.Duration.week)
              Text("Always").tag(ChatPermissionAction.Duration.always)
            }
            .pickerStyle(.menu).labelsHidden()
            .disabled(store.isSaving || isLoading)
            .accessibilityIdentifier("permission-batch-duration")
          }
          .frame(minHeight: 44)
          if store.duration == .always {
            Text("New permissions won’t expire automatically.")
              .font(.footnote).foregroundStyle(.secondary)
          }
        }
        Button {
          guard let reviewed = snapshot else { return }
          Task { await store.confirm(reviewed) }
        } label: {
          ChatSettingsActionLabel(title: confirmationTitle, isBusy: store.isSaving)
        }
        .buttonStyle(OkouButtonStyle(isPrimary: true))
        .disabled(!canConfirm)
        .accessibilityIdentifier("permission-batch-confirm")
        if store.action.callbackPrompt != nil {
          Text("The chat will continue after confirmation.")
            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
    .background(Color(uiColor: .systemGroupedBackground))
    .overlay(alignment: .top) { Divider() }
  }

  private var confirmationTitle: LocalizedStringKey {
    if store.isContinuing { return "Continuing chat…" }
    if store.isSaving { return "Saving permissions…" }
    if needsContinuation { return "Continue chat" }
    let missing = store.action.items.count - (snapshot?.allowedCount ?? 0)
    return "Allow \(missing) permissions"
  }
}

private struct PermissionBatchGroup: View {
  let group: ChatPermissionBatchSnapshot.Group
  let verifiesGrants: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "app.connected.to.app.below.fill")
          .foregroundStyle(.secondary).accessibilityHidden(true)
        Text(group.metadata?.label ?? group.connectorSlug).font(.headline)
        Spacer(minLength: 0)
        Text("\(group.items.count) permissions").font(.caption).foregroundStyle(.secondary)
      }
      ForEach(group.items) { item in
        Divider()
        permission(item)
      }
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 20))
  }

  private func permission(_ item: ChatPermissionBatchAction.Item) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if let description = group.metadata?.permissions.first(where: { $0.name == item.permission })?
        .description
      {
        Text(description).font(.subheadline).textSelection(.enabled)
      }
      Text(
        item.permission == "__unknown__" ? String(localized: "Other endpoints") : item.permission
      )
      .font(.caption.monospaced()).foregroundStyle(.secondary)
      .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
      if verifiesGrants && group.allows(item) {
        Label("Already allowed", systemImage: "checkmark.circle")
          .font(.caption).foregroundStyle(.green)
        if let grant = group.grant(for: item) {
          if let expiry = grant.expiresAt {
            Text("Expires \(expiry.formatted(date: .abbreviated, time: .shortened))")
              .font(.caption).foregroundStyle(.secondary)
          } else {
            Text("No expiration").font(.caption).foregroundStyle(.secondary)
          }
        } else {
          Text("Allowed by default").font(.caption).foregroundStyle(.secondary)
        }
      } else if group.metadata?.contains(item.permission) != true {
        Text("This permission is no longer available.")
          .font(.caption).foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}
