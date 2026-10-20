import ChatData
import ChatDomain
import Foundation

/// All changing card inputs participate in the native collection's measurement revision.
struct AssistantFailureState: Equatable {
  let failure: ChatFailure
  let recovery: ChatFailure.Recovery
  let isCurrent: Bool
  let isBusy: Bool
  let canSend: Bool
  let accountLabel: String?
  let disconnected: Bool
  let resetDetails: [String]
  let resetAccountID: String?
  let resetsRemaining: Int
  let accountError: String?
  var billing: ChatBillingRecovery? = nil
  var billingError: String? = nil

  var showsModelPicker: Bool {
    recovery.showsModelPicker
      || (recovery.kind == .retryable
        && ![
          "guest_root_filesystem_full", "guest_home_filesystem_full",
          "codex_access_program_unavailable",
        ]
        .contains(failure.reason))
  }
  var actionTitle: String { recovery.continues ? "Continue" : "Try again" }

  @MainActor static func make(
    failure: ChatFailure, current: Bool, selection: ChatModelSelectionStore?,
    accountsReady: Bool, busy: Bool
  ) -> Self {
    let route = selection?.models.configuration?.row(
      for: selection?.selection ?? ChatModelSelection())?
      .memberEffective.providerType
    let framework: ChatFailure.Framework? =
      route == PersonalSubscriptionType.codex.rawValue
      ? .codex
      : (route == PersonalSubscriptionType.claude.rawValue ? .claude : nil)
    let recovery = failure.recovery(personalFramework: current ? framework : nil)
    let subscriptions = selection?.models.subscriptions
    let readsAccount =
      current && recovery.kind == .usage && framework != nil
      && framework == recovery.framework
    let account =
      readsAccount && accountsReady
      ? subscriptions?.accounts.first {
        $0.type == route && $0.isActive != false && !$0.needsReconnect
      }
      : nil
    var windows: [(ChatFailure.Window, PersonalSubscription.Window?)] = []
    if let account {
      switch recovery.window {
      case .fiveHour: windows = [(.fiveHour, account.subscriptionUsage?.fiveHour)]
      case .weekly: windows = [(.weekly, account.subscriptionUsage?.weekly)]
      case .unknown:
        windows = [
          (.fiveHour, account.subscriptionUsage?.fiveHour),
          (.weekly, account.subscriptionUsage?.weekly),
        ]
        .filter { $0.1?.remainingPercent == 0 || ($0.1?.usedPercent ?? 0) >= 100 }
      default: break
      }
    }
    let details = windows.compactMap { window, usage -> String? in
      guard let date = usage?.resetAt else { return nil }
      let time = date.formatted(date: .abbreviated, time: .shortened)
      return windows.count > 1
        ? "\(window == .fiveHour ? "5h" : "Week") resets \(time)" : "Resets \(time)"
    }
    let resets = account?.subscriptionResetCredits ?? 0
    let resetAllowed = recovery.framework == .codex && !recovery.modelScoped && resets > 0
    return Self(
      failure: failure, recovery: recovery, isCurrent: current,
      isBusy: busy || selection?.isBusy == true || subscriptions?.isMutating == true
        || (readsAccount && !accountsReady && subscriptions?.error == nil),
      canSend: selection?.canSend != false,
      accountLabel: account?.accountEmail ?? account?.workspaceName,
      disconnected: readsAccount && accountsReady && account == nil,
      resetDetails: details.isEmpty ? recovery.resetLabel.map { ["Resets \($0)"] } ?? [] : details,
      resetAccountID: resetAllowed ? account?.id : nil, resetsRemaining: resets,
      accountError: readsAccount && !accountsReady ? subscriptions?.error : nil)
  }
}
