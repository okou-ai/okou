# iOS Development

Apply the repository-wide instructions and read
[iOS development](../docs/ios/ios-development.md) for package boundaries, state
owners, concurrency, and verification. For resource graphs, commands, native
bindings, subscriptions, or cancellation, read
[iOS ccstate](../docs/ios/ios-ccstate.md); browser/TypeScript ccstate syntax is not
the native API contract. For tests, follow [iOS testing](../docs/ios/ios-testing.md).

## Mobile UI Authority

Read [the Mobile Design System](../docs/ios/mobile-design-system.md) before designing,
implementing, or reviewing native UI.

- Use `Okou/DesignSystem/` for shared tokens, assets, and UI primitives. Reuse the
  component catalog before adding a new style or component.
- Match Web color **roles**, not just hex values. Generate shared colors from
  Web sources; never edit generated files or introduce local color literals.
- Keep native type, spacing, radii, and targets independent of Web geometry.
- Use registered Lucide assets through `OkouIcon`, `Label(okouSymbol:)`, and
  `Button(okouSymbol:)`. New first-party icons do not use SF Symbols.
- Before changing icon dimensions, compare against native controls in the Debug
  catalog. Keep compiled menu image intrinsic size separate from SwiftUI layout
  frames and the 44 pt hit target. Use named icon roles rather than local sizes.
- Add a reusable token/component at its owner before using a new pattern in a
  feature. Record necessary platform/SDK exceptions in the design-system guide.
- Preserve native focus, editing, accessibility, dismissal, and authentication
  behavior. Visual references do not authorize replacing those contracts.
- Run the synchronization checks and relevant native verification documented
  in the guide. Do not claim visual acceptance from a successful build alone.

## Swift checks

- Run `bash ios/scripts/lint.sh` after Swift changes. Install the pinned version
  with `bash ios/scripts/install-swiftlint.sh`; see [the README](README.md#swiftlint).
- `swift-format` owns formatting; SwiftLint owns the explicit safety rules in
  `.swiftlint.yml`. The initial rules are SwiftSyntax-only, with no App build or
  SourceKit requirement. Keep the macOS pin and CI image on the same release.
- Test and test-support directories relax only force casts and force tries.
  Fix production findings at their source; do not add a baseline, inline
  suppression or broader exclusions just to pass CI.
