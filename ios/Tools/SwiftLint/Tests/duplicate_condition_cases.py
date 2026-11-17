"""Reject duplicate branches while preserving distinct native conditions."""

DUPLICATE_CONDITION_CASES = [
    (
        "duplicate conditions in one if chain are rejected",
        "duplicate_conditions",
        """
        func classify(_ value: Int) -> Int {
          if value == 1 { // violation
            return 10
          } else if value == 2 {
            return 20
          } else if value == 1 { // violation
            return 30
          }
          return 0
        }
    """,
    ),
    (
        "duplicate cases in one switch are rejected",
        "duplicate_conditions",
        """
        func classify(_ value: Int) -> Int {
          switch value {
          case 1: return 10 // violation
          case 2: return 20
          case 1: return 30 // violation
          default: return 0
          }
        }
    """,
    ),
    (
        "independent checks and distinct condition sets remain valid",
        "duplicate_conditions",
        """
        func independent(_ value: Int) {
          if value == 1 { owner.prepare() }
          if value == 1 { owner.finish() }
        }
        func classify(_ value: Int, ready: Bool) -> Int {
          if value > 0, ready {
            return 10
          } else if value > 0 {
            return 20
          }
          return 0
        }
        func guarded(_ value: Int, ready: Bool) -> Int {
          switch value {
          case 1 where ready: return 10
          case 1 where !ready: return 20
          default: return 0
          }
        }
        func binding(_ first: Int?, _ second: Int?) -> Int {
          if let value = first {
            return value
          } else if let value = second {
            return value
          }
          return 0
        }
    """,
    ),
]
