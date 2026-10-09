import AppKit
import OkouCore
import Sparkle

/// Keep Sparkle's standard interaction for optional updates. Required updates
/// use the main window and the same verified download/install implementation.
@MainActor
final class DesktopUpdateDriver: NSObject, SPUUserDriver {
  private let standard = SPUStandardUserDriver(hostBundle: .main, delegate: nil)
  private let model: DesktopModel
  private var expectedBytes: UInt64 = 0
  private var receivedBytes: UInt64 = 0
  private var offeredVersion: String?
  private var informationOnly = false
  private var pendingChoice: ((SPUUserUpdateChoice) -> Void)?
  private(set) var sessionInProgress = false

  init(model: DesktopModel) { self.model = model }
  static func failureMessage(_ error: Error) -> String {
    let failure = error as NSError
    if failure.domain == SUSparkleErrorDomain && failure.code == Int(SUError.noUpdateError.rawValue)
    {
      return "No supported update is available. Retry or download the latest Okou."
    }
    return error.localizedDescription
  }
  func requireUpgrade() {
    guard let pendingChoice, let offeredVersion, !informationOnly,
      model.compatibility.permitsUpdate(offeredVersion)
    else { return }
    standard.dismissUpdateInstallation()
    self.pendingChoice = nil
    Task {
      await model.drainForUpgrade()
      pendingChoice(.install)
    }
  }
  func show(
    _ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void
  ) {
    standard.show(request, reply: reply)
  }
  func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
    sessionInProgress = true
    if model.compatibility.required {
      model.upgradePhase = .checking
    } else {
      standard.showUserInitiatedUpdateCheck(cancellation: cancellation)
    }
  }
  func showUpdateFound(
    with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
    reply: @escaping (SPUUserUpdateChoice) -> Void
  ) {
    sessionInProgress = true
    offeredVersion = appcastItem.versionString
    informationOnly = appcastItem.isInformationOnlyUpdate
    if model.compatibility.required {
      guard !appcastItem.isInformationOnlyUpdate,
        model.compatibility.permitsUpdate(appcastItem.versionString)
      else {
        model.upgradePhase = .failed(
          "No supported update is available. Retry or download the latest Okou.")
        reply(.dismiss)
        return
      }
      if state.stage == .installing {
        Task {
          await model.drainForUpgrade()
          reply(.install)
        }
      } else {
        reply(.install)
      }
    } else {
      pendingChoice = reply
      standard.showUpdateFound(with: appcastItem, state: state) { [weak self] choice in
        guard let reply = self?.pendingChoice else { return }
        self?.pendingChoice = nil
        guard let self else {
          reply(.dismiss)
          return
        }
        if self.model.compatibility.required && choice == .install {
          guard !self.informationOnly,
            self.model.compatibility.permitsUpdate(appcastItem.versionString)
          else {
            self.model.upgradePhase = .failed(
              "This update no longer meets the minimum version. Retry for a supported update.")
            reply(.skip)
            return
          }
          Task {
            await self.model.drainForUpgrade()
            reply(.install)
          }
        } else {
          reply(choice)
        }
      }
    }
  }
  func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
    if !model.compatibility.required { standard.showUpdateReleaseNotes(with: downloadData) }
  }
  func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {
    if !model.compatibility.required {
      standard.showUpdateReleaseNotesFailedToDownloadWithError(error)
    }
  }
  func showUpdateNotFoundWithError(_ error: Error) async {
    if model.compatibility.required {
      model.upgradePhase = .failed(
        "No supported update is available. Retry or download the latest Okou.")
    } else {
      await standard.showUpdateNotFoundWithError(error)
    }
  }
  func showUpdaterError(_ error: Error) async {
    if model.compatibility.required {
      model.upgradePhase = .failed(Self.failureMessage(error))
    } else {
      await standard.showUpdaterError(error)
    }
  }
  func showDownloadInitiated(cancellation: @escaping () -> Void) {
    expectedBytes = 0
    receivedBytes = 0
    if model.compatibility.required {
      model.upgradePhase = .downloading(nil)
    } else {
      standard.showDownloadInitiated(cancellation: cancellation)
    }
  }
  func showDownloadDidReceiveExpectedContentLength(_ length: UInt64) {
    expectedBytes = length
    if model.compatibility.required {
      publishDownload()
    } else {
      standard.showDownloadDidReceiveExpectedContentLength(length)
    }
  }
  func showDownloadDidReceiveData(ofLength length: UInt64) {
    receivedBytes += length
    if model.compatibility.required {
      publishDownload()
    } else {
      standard.showDownloadDidReceiveData(ofLength: length)
    }
  }
  private func publishDownload() {
    model.upgradePhase = .downloading(
      expectedBytes > 0 ? min(1, Double(receivedBytes) / Double(expectedBytes)) : nil)
  }
  func showDownloadDidStartExtractingUpdate() {
    if model.compatibility.required {
      model.upgradePhase = .extracting(nil)
    } else {
      standard.showDownloadDidStartExtractingUpdate()
    }
  }
  func showExtractionReceivedProgress(_ progress: Double) {
    if model.compatibility.required {
      model.upgradePhase = .extracting(progress)
    } else {
      standard.showExtractionReceivedProgress(progress)
    }
  }
  func showReadyToInstallAndRelaunch() async -> SPUUserUpdateChoice {
    if model.compatibility.required {
      guard let offeredVersion, model.compatibility.permitsUpdate(offeredVersion) else {
        model.upgradePhase = .failed(
          "The downloaded update no longer meets the minimum version. Retry for a supported update."
        )
        return .skip
      }
      await model.drainForUpgrade()
      model.upgradePhase = .installing
      return .install
    }
    return await standard.showReadyToInstallAndRelaunch()
  }
  func showInstallingUpdate(
    withApplicationTerminated terminated: Bool,
    retryTerminatingApplication: @escaping () -> Void
  ) {
    if model.compatibility.required {
      model.upgradePhase = .installing
    } else {
      standard.showInstallingUpdate(
        withApplicationTerminated: terminated,
        retryTerminatingApplication: retryTerminatingApplication)
    }
  }
  func showUpdateInstalledAndRelaunched(_ relaunched: Bool) async {
    if !model.compatibility.required { await standard.showUpdateInstalledAndRelaunched(relaunched) }
  }
  func finishCycle() { sessionInProgress = false }
  func dismissUpdateInstallation() {
    sessionInProgress = false
    pendingChoice = nil
    offeredVersion = nil
    standard.dismissUpdateInstallation()
  }
}
