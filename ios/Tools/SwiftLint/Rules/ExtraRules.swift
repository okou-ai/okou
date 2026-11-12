import SwiftLintCore

public func extraRules() -> [any Rule.Type] {
  [
    RenderEffectsRule.self, StableGraphRule.self, PrivateAtomsRule.self,
    AccessorEscapeRule.self, NativeRequestsRule.self, ResourceFailuresRule.self,
    TestSynchronizationRule.self,
    CheckAfterAwaitRule.self, ResourceCancellationRule.self,
    SubscriptionTeardownRule.self,
    ImportBoundariesRule.self,
    StorageBoundariesRule.self,
    TaskLifecycleRule.self,
  ]
}
