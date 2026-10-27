import ClerkKit
import Foundation

/// The app and extension share the app's existing Keychain service and access group.
/// Keeping the original service/group preserves sessions across the upgrade.
/// Runtime identity uses the fixed signing-team prefix: an unsigned archive has
/// no AppIdentifierPrefix, and promotion must not rewrite its runtime settings.
enum PushConfiguration {
  static func keychain(bundle: Bundle = .main) -> Clerk.Options.KeychainConfig {
    .init(
      service: "ai.okou.ios",
      accessGroup: bundle.object(
        forInfoDictionaryKey: "ClerkKeychainAccessGroup") as? String)
  }

  static func directory(bundle: Bundle = .main) -> URL? {
    guard let group = bundle.object(forInfoDictionaryKey: "NotificationAppGroup") as? String,
      !group.isEmpty
    else { return nil }
    return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
  }
}
