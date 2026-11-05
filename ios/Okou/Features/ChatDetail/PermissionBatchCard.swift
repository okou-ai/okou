import ChatData
import SwiftUI

struct PermissionBatchCard: View {
  @Bindable var store: PermissionBatchStore
  let loadsState: Bool
  @Environment(\.scenePhase) private var scenePhase
  @State private var showsDetails = false

  private var status: String {
    if store.isContinuing { return String(localized: "Continuing chat…") }
    if store.isSaving { return String(localized: "Saving permissions…") }
    if store.isLoading { return String(localized: "Checking permissions…") }
    if store.requiresReadback { return String(localized: "Check permission status") }
    guard let snapshot = store.snapshot else {
      return String(localized: "Checking permissions…")
    }
    if !snapshot.complete { return String(localized: "Permission request unavailable") }
    if store.hasContinued && store.allAllowed {
      return String(localized: "Permissions allowed · Chat continued")
    }
    if store.needsContinuation {
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
        if store.allAllowed && !store.needsContinuation {
          Label("View details", systemImage: "checkmark.circle")
        } else if store.needsContinuation {
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

struct PermissionBatchDetails: View {
  @Environment(\.singleAgentExperience) private var singleAgent

  @Bindable var store: PermissionBatchStore
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          requestSummary
          if let snapshot = store.snapshot {
            if snapshot.enabled {
              Text(
                snapshot.connectorScoped
                  ? "These permissions apply to these connectors across your chats and accounts."
                  : (singleAgent
                    ? "These permissions apply to your account for Okou across chats in this workspace."
                    : "These permissions apply to your account for this Agent.")
              )
              .font(.footnote).foregroundStyle(.secondary)
              ForEach(snapshot.groups) { group in
                PermissionBatchGroup(group: group, verifiesGrants: !store.requiresReadback)
              }
            } else {
              Text("Batch permissions are not available for your account right now.")
                .foregroundStyle(.secondary)
            }
          }
          if let error = store.error {
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
      Image(systemName: store.allAllowed ? "checkmark.shield" : "lock.shield")
        .font(.title3)
        .foregroundStyle(store.allAllowed ? Color.green : Color.secondary)
        .frame(width: 40, height: 40)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 6) {
        Text("\(store.action.items.count) permissions requested").font(.headline)
        Text(
          "Requested by \(singleAgent ? "Okou" : (store.snapshot?.agentName ?? String(localized: "this Agent")))"
        )
        .font(.subheadline).foregroundStyle(.secondary)
        if let snapshot = store.snapshot, snapshot.enabled && !store.requiresReadback {
          Text("\(snapshot.allowedCount) of \(store.action.items.count) permissions allowed")
            .font(.footnote).foregroundStyle(.secondary)
        }
        if store.hasContinued {
          Text("Your chat has continued.").font(.footnote).foregroundStyle(.secondary)
        } else if store.needsContinuation && store.error != nil {
          Text("Permissions allowed · Chat not continued")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }
    }
  }

  private var confirmation: some View {
    VStack(spacing: 12) {
      if store.isLoading && store.snapshot == nil {
        ProgressView("Checking permissions…").frame(minHeight: 44)
      } else if store.requiresReadback || store.snapshot == nil {
        if store.requiresReadback {
          Text("Check the current permissions before trying again.")
            .font(.footnote).foregroundStyle(.secondary)
        }
        Button("Check permissions") { Task { await store.refresh() } }
          .frame(minHeight: 44).disabled(store.isLoading || store.isSaving)
      } else if store.snapshot?.complete != true {
        Text("These permissions are no longer available.")
          .font(.footnote).foregroundStyle(.secondary)
      } else if store.allAllowed && !store.needsContinuation && !store.isSaving {
        Button("Done") { dismiss() }
          .buttonStyle(OkouButtonStyle(isPrimary: true))
      } else {
        if !store.allAllowed && !store.isContinuing {
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
            .disabled(store.isSaving || store.isLoading)
            .accessibilityIdentifier("permission-batch-duration")
          }
          .frame(minHeight: 44)
          if store.duration == .always {
            Text("New permissions won’t expire automatically.")
              .font(.footnote).foregroundStyle(.secondary)
          }
        }
        Button {
          Task { await store.confirm() }
        } label: {
          ChatSettingsActionLabel(title: confirmationTitle, isBusy: store.isSaving)
        }
        .buttonStyle(OkouButtonStyle(isPrimary: true))
        .disabled(!store.canConfirm)
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
    if store.needsContinuation { return "Continue chat" }
    let missing = store.action.items.count - (store.snapshot?.allowedCount ?? 0)
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
