import SwiftSyntax

struct NativeLifetimeIndex {
  let identity: String
  var freshUUID: AbsolutePosition?

  static func resolve(
    _ expression: ExprSyntax, aliases: [String: NativeLifetimeIndex] = [:], depth: Int = 0
  ) -> NativeLifetimeIndex {
    guard depth < 16 else { return NativeLifetimeIndex(identity: "unknown:\(expression.position)") }
    if let reference = expression.as(DeclReferenceExprSyntax.self) {
      let name = reference.baseName.text
      for ancestor in ancestors(of: expression) {
        if let statements = ancestor.as(CodeBlockItemListSyntax.self) {
          for statement in statements.reversed() where statement.position < expression.position {
            if let guardStatement = statement.item.as(GuardStmtSyntax.self),
              expression.position >= guardStatement.endPosition,
              let binding = optional(name, in: guardStatement.conditions)
            {
              return binding
            }
            guard let variable = statement.item.as(VariableDeclSyntax.self) else { continue }
            for binding in variable.bindings
            where binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name
              && !(binding.position <= expression.position
                && expression.position < binding.endPosition)
            {
              guard variable.bindingSpecifier.text == "let" else {
                return NativeLifetimeIndex(
                  identity: "mutable:\(binding.position):\(expression.position)")
              }
              if let source = binding.initializer?.value {
                let original = resolve(source, aliases: aliases, depth: depth + 1)
                if source.is(DeclReferenceExprSyntax.self)
                  || source.is(MemberAccessExprSyntax.self)
                  || source.is(StringLiteralExprSyntax.self)
                  || source.is(IntegerLiteralExprSyntax.self) || original.freshUUID != nil
                {
                  return original
                }
              }
              return NativeLifetimeIndex(identity: "local:\(binding.position)")
            }
          }
        }
        if let branch = ancestor.as(IfExprSyntax.self),
          branch.body.position <= expression.position
            && expression.position < branch.body.endPosition,
          let binding = optional(name, in: branch.conditions)
        {
          return binding
        }
        if let loop = ancestor.as(WhileStmtSyntax.self),
          loop.body.position <= expression.position && expression.position < loop.body.endPosition,
          let binding = optional(name, in: loop.conditions)
        {
          return binding
        }
        let parameters =
          ancestor.as(FunctionDeclSyntax.self)?.signature.parameterClause.parameters
          ?? ancestor.as(InitializerDeclSyntax.self)?.signature.parameterClause.parameters
        if let parameter = parameters?.first(where: { ($0.secondName ?? $0.firstName).text == name }
        ) {
          if parameter.type.trimmedDescription.hasPrefix("inout ") {
            return NativeLifetimeIndex(
              identity: "mutable:\(parameter.position):\(expression.position)")
          }
          let identity = "parameter:\(parameter.position)"
          return aliases[identity] ?? NativeLifetimeIndex(identity: identity)
        }
        if let loop = ancestor.as(ForStmtSyntax.self),
          nativeLifetimeBindings(loop.pattern).contains(name)
        {
          return NativeLifetimeIndex(identity: "iteration:\(loop.position):\(name)")
        }
        if let closure = ancestor.as(ClosureExprSyntax.self),
          closureParameters(closure).contains(name)
        {
          return NativeLifetimeIndex(identity: "closure:\(closure.position):\(name)")
        }
        if ancestor.is(MemberBlockSyntax.self) { break }
      }
      return NativeLifetimeIndex(identity: "self." + name)
    }
    if let member = expression.as(MemberAccessExprSyntax.self), let base = member.base {
      if base.trimmedDescription == "self" {
        return NativeLifetimeIndex(identity: "self." + member.declName.baseName.text)
      }
      let original = resolve(base, aliases: aliases, depth: depth + 1)
      return NativeLifetimeIndex(
        identity: original.identity + "." + member.declName.baseName.text,
        freshUUID: member.declName.baseName.text == "uuidString" ? original.freshUUID : nil)
    }
    if let literal = expression.as(StringLiteralExprSyntax.self),
      literal.segments.allSatisfy({ $0.is(StringSegmentSyntax.self) })
    {
      return NativeLifetimeIndex(identity: expression.trimmedDescription)
    }
    if expression.is(IntegerLiteralExprSyntax.self) {
      return NativeLifetimeIndex(identity: expression.trimmedDescription)
    }
    if let call = expression.as(FunctionCallExprSyntax.self), call.arguments.isEmpty {
      if ["UUID", "Foundation.UUID", "UUID.init", "Foundation.UUID.init"].contains(
        call.calledExpression.trimmedDescription)
      {
        return NativeLifetimeIndex(identity: "uuid:\(call.position)", freshUUID: call.position)
      }
      if let member = call.calledExpression.as(MemberAccessExprSyntax.self),
        member.declName.baseName.text == "lowercased", let base = member.base
      {
        let original = resolve(base, aliases: aliases, depth: depth + 1)
        if original.freshUUID != nil {
          return NativeLifetimeIndex(
            identity: original.identity + ".lowercased()", freshUUID: original.freshUUID)
        }
      }
    }
    return NativeLifetimeIndex(identity: "expression:\(expression.position)")
  }

  private static func optional(_ name: String, in conditions: ConditionElementListSyntax)
    -> NativeLifetimeIndex?
  {
    for condition in conditions {
      if let binding = condition.condition.as(OptionalBindingConditionSyntax.self),
        binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name
      {
        return NativeLifetimeIndex(identity: "binding:\(binding.position)")
      }
    }
    return nil
  }
}

struct NativeLifetimeSlot {
  let field: String
  let index: NativeLifetimeIndex
  let syntax: SubscriptCallExprSyntax

  var storage: String { "self." + field + "[" + index.identity + "]" }

  func fresh(in statements: CodeBlockItemListSyntax, repeated: Syntax?) -> Bool {
    guard let creation = index.freshUUID, creation >= statements.position,
      repeated.map({ creation > $0.position }) != false
    else { return false }
    return true
  }
}

func nativeLifetimeBindings(_ pattern: PatternSyntax) -> Set<String> {
  if let identifier = pattern.as(IdentifierPatternSyntax.self) {
    return [identifier.identifier.text]
  }
  if let tuple = pattern.as(TuplePatternSyntax.self) {
    return tuple.elements.reduce(into: []) { $0.formUnion(nativeLifetimeBindings($1.pattern)) }
  }
  if let binding = pattern.as(ValueBindingPatternSyntax.self) {
    return nativeLifetimeBindings(binding.pattern)
  }
  return []
}
