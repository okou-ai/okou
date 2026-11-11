import CCStateSwiftUI
import ChatData
import SwiftUI

struct PermissionBatchCard: View {
  let store: PermissionBatchStore
  let loadsState: Bool
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    PermissionCardReadView(read: store.read) { phase in
      PermissionBatchCardContent(store: store, phase: phase)
    }
    .task(id: store.isActive) {
      if loadsState && store.isActive { await store.loadIfNeeded() }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active && store.isActive && loadsState {
        Task { await store.refresh() }
      }
    }
  }
}

private struct PermissionBatchCardContent: View {
  @Bindable var store: PermissionBatchStore
  let phase: Loadable<ChatPermissionBatchSnapshot>
  @State private var showsDetails = false

  private var isLoading: Bool { phase.state == .loading }
  private var snapshot: ChatPermissionBatchSnapshot? { phase.data ?? store.snapshot }
  private var requiresReadback: Bool { store.requiresReadback || phase.error != nil }
  private var allAllowed: Bool { phase.data?.allAllowed == true && !requiresReadback }
  private var needsContinuation: Bool {
    allAllowed && store.action.callbackPrompt != nil && !store.hasContinued
  }
  private var error: String? {
    phase.error.map(ChatRequestFailure.message(for:)) ?? store.error
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

  }
}

struct PermissionBatchDetails: View {
  let store: PermissionBatchStore

  var body: some View {
    PermissionCardReadView(read: store.read) { phase in
      PermissionBatchDetailsContent(store: store, phase: phase)
    }
    .task { await store.refresh() }
  }
}

private struct PermissionBatchDetailsContent: View {
  @Bindable var store: PermissionBatchStore
  let phase: Loadable<ChatPermissionBatchSnapshot>
  @Environment(\.dismiss) private var dismiss

  private var isLoading: Bool { phase.state == .loading }
  private var snapshot: ChatPermissionBatchSnapshot? { phase.data ?? store.snapshot }
  private var requiresReadback: Bool { store.requiresReadback || phase.error != nil }
  private var allAllowed: Bool { phase.data?.allAllowed == true && !requiresReadback }
  private var needsContinuation: Bool {
    allAllowed && store.action.callbackPrompt != nil && !store.hasContinued
  }
  private var error: String? {
    phase.error.map(ChatRequestFailure.message(for:)) ?? store.error
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
          Task { [snapshot] in await store.confirm(reviewing: snapshot) }
        } label: {
          ChatSettingsActionLabel(title: confirmationTitle, isBusy: store.isSaving)
        }
        .buttonStyle(OkouButtonStyle(isPrimary: true))
        .disabled(!store.canConfirm(reviewing: snapshot) || isLoading || phase.error != nil)
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
