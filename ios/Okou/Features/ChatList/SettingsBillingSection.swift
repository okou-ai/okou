import CCStateSwiftUI
import ChatData
import SwiftUI

struct SettingsBillingSection: View {
  let workspace: WorkspaceStore
  @LoadableValue private var billing: Loadable<WorkspaceBilling>
  @LoadableStatus<WorkspaceBilling> private var billingStatus: LoadableState

  init(workspace: WorkspaceStore) {
    self.workspace = workspace
    _billing = LoadableValue(task: workspace.settingsResources.billingValue, keepLast: true)
    _billingStatus = LoadableStatus(task: workspace.settingsResources.billingValue)
  }

  var body: some View {
    Section {
      Group {
        switch billing {
        case .hasData(let status):
          HStack(spacing: OkouSpace.sm) {
            OkouValueRow(value: planName(status.tier)) {
              OkouRowLabel("Current plan", okouSymbol: "layers")
            }
            if billingStatus == .loading {
              ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
            }
          }
        case .loading:
          HStack {
            OkouRowLabel("Current plan", okouSymbol: "layers")
            Spacer(minLength: OkouSpace.sm)
            OkouSkeletonBlock(width: OkouSpace.xxxl * 2, height: OkouControl.skeletonLine)
              .okouShimmer()
              .accessibilityLabel("Loading plan")
          }
        case .hasError(let error):
          OkouLoadErrorRow(
            message: ChatRequestFailure.message(for: error), isRetrying: billingStatus == .loading
          ) {
            await workspace.refreshSettingsBilling()
          }
        }
      }
      .frame(minHeight: OkouControl.inlineActionHeight)
      .accessibilityIdentifier("settings-current-plan")
      SettingsCreditBalanceRow(workspace: workspace)
      Link(destination: workspace.billingURL) {
        OkouRowLabel("Manage billing", okouSymbol: "arrow-up-right")
      }
      .accessibilityIdentifier("settings-manage-billing")
    } header: {
      Text("Billing").okouSectionHeader()
    }
  }

  private func planName(_ tier: String) -> Text {
    switch tier {
    case "limited-free-1": Text("Free")
    case "pro": Text(verbatim: "Pro")
    case "team": Text(verbatim: "Team")
    case "custom": Text("Custom")
    default: Text(verbatim: tier)
    }
  }
}

private struct SettingsCreditBalanceRow: View {
  let workspace: WorkspaceStore
  @ResolvedValue private var enabled: Bool?
  @LoadableValue private var credits: Loadable<Double?>
  @LoadableStatus<Double?> private var status: LoadableState

  init(workspace: WorkspaceStore) {
    self.workspace = workspace
    _enabled = ResolvedValue(task: workspace.settingsResources.billingCreditsEnabled)
    _credits = LoadableValue(task: workspace.settingsResources.billingCreditsValue, keepLast: true)
    _status = LoadableStatus(task: workspace.settingsResources.billingCreditsValue)
  }

  var body: some View {
    if enabled == true {
      content
        .frame(minHeight: OkouControl.inlineActionHeight)
        .accessibilityIdentifier("settings-credit-balance")
    }
  }

  @ViewBuilder private var content: some View {
    switch credits {
    case .hasData(let value):
      if let value {
        HStack(spacing: OkouSpace.sm) {
          OkouValueRow(value: Text(value, format: .number)) {
            OkouRowLabel("Credit balance", okouSymbol: "package")
          }
          .monospacedDigit()
          if status == .loading {
            ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
          }
        }
      }
    case .loading:
      HStack {
        OkouRowLabel("Credit balance", okouSymbol: "package")
        Spacer(minLength: OkouSpace.sm)
        OkouSkeletonBlock(width: OkouSpace.xxxl * 2, height: OkouControl.skeletonLine)
          .okouShimmer()
          .accessibilityLabel("Loading credits")
      }
    case .hasError(let error):
      OkouLoadErrorRow(
        message: ChatRequestFailure.message(for: error), isRetrying: status == .loading
      ) {
        await workspace.refreshSettingsBilling()
      }
    }
  }
}
