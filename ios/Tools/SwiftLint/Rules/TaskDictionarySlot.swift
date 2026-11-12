import SwiftSyntax

struct NativeTaskIndex {
  let identity: String
  var freshUUID: AbsolutePosition?

  static func resolve(
    _ expression: ExprSyntax, aliases: [String: NativeTaskIndex] = [:], depth: Int = 0
  ) -> NativeTaskIndex {
    guard depth < 16 else { return NativeTaskIndex(identity: "unknown:\(expression.position)") }
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
                return NativeTaskIndex(
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
              return NativeTaskIndex(identity: "local:\(binding.position)")
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
            return NativeTaskIndex(identity: "mutable:\(parameter.position):\(expression.position)")
          }
          let identity = "parameter:\(parameter.position)"
          return aliases[identity] ?? NativeTaskIndex(identity: identity)
        }
        if let loop = ancestor.as(ForStmtSyntax.self),
          loop.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name
        {
          return NativeTaskIndex(identity: "iteration:\(loop.position)")
        }
        if let closure = ancestor.as(ClosureExprSyntax.self),
          closureParameters(closure).contains(name)
        {
          return NativeTaskIndex(identity: "closure:\(closure.position):\(name)")
        }
        if ancestor.is(MemberBlockSyntax.self) { break }
      }
      return NativeTaskIndex(identity: "self." + name)
    }
    if let member = expression.as(MemberAccessExprSyntax.self), let base = member.base {
      if base.trimmedDescription == "self" {
        return NativeTaskIndex(identity: "self." + member.declName.baseName.text)
      }
      let original = resolve(base, aliases: aliases, depth: depth + 1)
      return NativeTaskIndex(
        identity: original.identity + "." + member.declName.baseName.text,
        freshUUID: member.declName.baseName.text == "uuidString" ? original.freshUUID : nil)
    }
    if let literal = expression.as(StringLiteralExprSyntax.self),
      literal.segments.allSatisfy({ $0.is(StringSegmentSyntax.self) })
    {
      return NativeTaskIndex(identity: expression.trimmedDescription)
    }
    if expression.is(IntegerLiteralExprSyntax.self) {
      return NativeTaskIndex(identity: expression.trimmedDescription)
    }
    if let call = expression.as(FunctionCallExprSyntax.self), call.arguments.isEmpty {
      if ["UUID", "Foundation.UUID", "UUID.init", "Foundation.UUID.init"].contains(
        call.calledExpression.trimmedDescription)
      {
        return NativeTaskIndex(identity: "uuid:\(call.position)", freshUUID: call.position)
      }
      if let member = call.calledExpression.as(MemberAccessExprSyntax.self),
        member.declName.baseName.text == "lowercased", let base = member.base
      {
        let original = resolve(base, aliases: aliases, depth: depth + 1)
        if original.freshUUID != nil {
          return NativeTaskIndex(
            identity: original.identity + ".lowercased()", freshUUID: original.freshUUID)
        }
      }
    }
    return NativeTaskIndex(identity: "expression:\(expression.position)")
  }

  private static func optional(_ name: String, in conditions: ConditionElementListSyntax)
    -> NativeTaskIndex?
  {
    for condition in conditions {
      if let binding = condition.condition.as(OptionalBindingConditionSyntax.self),
        binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name
      {
        return NativeTaskIndex(identity: "binding:\(binding.position)")
      }
    }
    return nil
  }
}

struct NativeTaskSlot {
  let field: String
  let index: NativeTaskIndex
  let syntax: SubscriptCallExprSyntax

  var storage: String { "self." + field + "[" + index.identity + "]" }

  func fresh(in statements: CodeBlockItemListSyntax, repeated: Syntax?) -> Bool {
    guard let creation = index.freshUUID, creation >= statements.position,
      repeated.map({ creation > $0.position }) != false
    else { return false }
    return true
  }
}
