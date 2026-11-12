import SwiftSyntax

struct NativeLifetimeScope {
  let statements: CodeBlockItemListSyntax
  let locals: Set<String>
  var initializer = false

  func repeated(_ node: some SyntaxProtocol) -> Syntax? {
    for ancestor in ancestors(of: node) {
      if ancestor.is(ClosureExprSyntax.self) || ancestor.is(FunctionDeclSyntax.self)
        || ancestor.is(InitializerDeclSyntax.self)
      {
        return nil
      }
      if ancestor.is(ForStmtSyntax.self) || ancestor.is(WhileStmtSyntax.self)
        || ancestor.is(RepeatStmtSyntax.self)
      {
        return ancestor
      }
    }
    return nil
  }
}

extension NativeLifetimeTrace {
  func preserves(
    _ node: FunctionCallExprSyntax, scope: NativeLifetimeScope, storage: String,
    slot: NativeLifetimeSlot? = nil
  ) -> Bool {
    let repeated = scope.repeated(node)
    if scope.initializer && repeated == nil { return true }
    let replacement = NativeLifetimeTrace(kind: kind, creation: nil, owner: owner, slot: slot)
    let original = NativeLifetimePath(
      values: [storage: .handle], locals: scope.locals, immutable: scope.locals, acquired: true)
    let preserved =
      scope.initializer
      || replacement.block(scope.statements, states: [original])
        .allSatisfy { replacement.finished($0) }
    guard let repeated else { return preserved }
    let iteration = NativeLifetimeTrace(
      kind: kind, creation: node.position, owner: owner, slot: slot)
    let body =
      repeated.as(ForStmtSyntax.self)?.body
      ?? repeated.as(WhileStmtSyntax.self)?.body
      ?? repeated.as(RepeatStmtSyntax.self)?.body
    let completes =
      body.map {
        iteration.block(
          $0.statements,
          states: [NativeLifetimePath(locals: scope.locals, immutable: scope.locals)]
        ).allSatisfy {
          !$0.acquired || $0.released || $0.transferred
            || [.breakLoop, .returned, .thrown].contains($0.exit)
        }
      } ?? false
    let retains = replacement.step(repeated, path: original)
      .allSatisfy { replacement.finished($0) }
    return preserved && (completes || retains)
  }
}
