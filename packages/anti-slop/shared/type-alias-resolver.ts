import type { ESTree } from "@oxlint/plugins";

type TypeAliasPolicy = {
  readonly includeUnions: boolean;
  readonly includePromises: boolean;
  readonly typeParameterScopes: (type: ESTree.TSType) => ReadonlyMap<string, ESTree.Node>;
};

type TypeNameBinding = {
  readonly scope: ESTree.Node;
  readonly alias: ESTree.TSTypeAliasDeclaration | null;
};

type TypeAliasResolver = {
  /** Resolve a type under the caller's alias and scope policy. */
  resolvesToUnknown(type: ESTree.TSType, policy: TypeAliasPolicy): boolean;
};

/** Check whether a switch discriminant creates a separate lexical scope. */
function isSwitchDiscriminant(node: ESTree.Node, switchStatement: ESTree.Node): boolean {
  let current: ESTree.Node = node;
  while (current.parent !== null && current.parent !== switchStatement) {
    current = current.parent;
  }
  return (
    current.parent === switchStatement &&
    switchStatement.type === "SwitchStatement" &&
    current === switchStatement.discriminant
  );
}

/** Check whether a node is a lexical scope that can contain a type declaration for `node`. */
function isLexicalScope(current: ESTree.Node, node: ESTree.Node): boolean {
  return (
    current.type === "Program" ||
    current.type === "BlockStatement" ||
    current.type === "StaticBlock" ||
    current.type === "TSModuleBlock" ||
    current.type === "ClassExpression" ||
    (current.type === "SwitchStatement" && !isSwitchDiscriminant(node, current))
  );
}

/** Find the nearest lexical scope that can contain a type declaration. */
function lexicalScope(node: ESTree.Node): ESTree.Node {
  let current: ESTree.Node | null = node;
  while (current !== null && !isLexicalScope(current, node)) {
    current = current.parent;
  }
  return current ?? node;
}

/** Find the parent lexical scope of a declaration scope. */
function parentLexicalScope(node: ESTree.Node): ESTree.Node | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && !isLexicalScope(current, node)) {
    current = current.parent;
  }
  return current;
}

/** Read a simple referenced type name. */
function referencedName(type: ESTree.TSType): string | null {
  if (type.type === "TSParenthesizedType") return referencedName(type.typeAnnotation);
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
  return type.typeName.name;
}

/** Check whether a type reference has explicit type arguments. */
function hasTypeArguments(type: ESTree.TSTypeReference): boolean {
  return type.typeArguments !== null && type.typeArguments.params.length > 0;
}

/** Count the parent links between a node and an ancestor. */
function distanceToAncestor(node: ESTree.Node, ancestor: ESTree.Node): number {
  let distance = 0;
  let current: ESTree.Node | null = node;
  while (current !== null) {
    if (current === ancestor) return distance;
    current = current.parent;
    distance += 1;
  }
  return Number.POSITIVE_INFINITY;
}

/** Read a named interface, class, enum, or import-equals declaration. */
function declaredTypeName(node: ESTree.Node): string | null {
  if (node.type === "TSInterfaceDeclaration") return node.id.name;
  if (node.type === "TSEnumDeclaration") return node.id.name;
  if (node.type === "TSImportEqualsDeclaration") return node.id.name;
  if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") return null;
  return node.id?.name ?? null;
}

/**
 * Index local aliases and resolve them in their declaration scope with cycle protection.
 *
 * @param declarations - Aliases collected from the current file.
 * @param shadowingDeclarations - Local declarations and imports that shadow aliases.
 * @returns A resolver isolated to those declarations.
 */
export function createTypeAliasResolver(
  declarations: readonly ESTree.TSTypeAliasDeclaration[],
  shadowingDeclarations: readonly ESTree.Node[],
): TypeAliasResolver {
  const namesByScope = new WeakMap<ESTree.Node, Map<string, TypeNameBinding>>();
  /** Bind a type name to an alias or a declaration that shadows one. */
  const setBinding = (
    scope: ESTree.Node,
    name: string,
    alias: ESTree.TSTypeAliasDeclaration | null,
  ): void => {
    let names = namesByScope.get(scope);
    if (names === undefined) {
      names = new Map();
      namesByScope.set(scope, names);
    }
    names.set(name, { scope, alias });
  };
  for (const declaration of declarations) {
    setBinding(lexicalScope(declaration), declaration.id.name, declaration);
  }
  for (const declaration of shadowingDeclarations) {
    if (declaration.type === "ImportDeclaration") {
      for (const specifier of declaration.specifiers) {
        setBinding(lexicalScope(specifier), specifier.local.name, null);
      }
      continue;
    }
    const name = declaredTypeName(declaration);
    if (name !== null) setBinding(lexicalScope(declaration), name, null);
  }

  /** Find the visible alias for a type reference. */
  const findAlias = (
    type: ESTree.TSType,
    typeParameterScopes: ReadonlyMap<string, ESTree.Node>,
  ): ESTree.TSTypeAliasDeclaration | null => {
    const name = referencedName(type);
    if (name === null) return null;
    let scope: ESTree.Node | null = lexicalScope(type);
    while (scope !== null) {
      const binding = namesByScope.get(scope)?.get(name);
      if (binding !== undefined) {
        const binder = typeParameterScopes.get(name);
        if (
          binder !== undefined &&
          distanceToAncestor(type, binder) <= distanceToAncestor(type, binding.scope)
        ) {
          return null;
        }
        return binding.alias;
      }
      scope = parentLexicalScope(scope);
    }
    return null;
  };

  /** Check whether a local declaration shadows a built-in type name. */
  const hasLocalTypeName = (
    type: ESTree.TSType,
    name: string,
    typeParameterScopes: ReadonlyMap<string, ESTree.Node>,
  ): boolean => {
    if (typeParameterScopes.has(name)) return true;
    let scope: ESTree.Node | null = lexicalScope(type);
    while (scope !== null) {
      if (namesByScope.get(scope)?.has(name) ?? false) return true;
      scope = parentLexicalScope(scope);
    }
    return false;
  };

  /** Resolve a type recursively while avoiding alias cycles. */
  const resolves = (
    type: ESTree.TSType,
    policy: TypeAliasPolicy,
    visited: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
  ): boolean => {
    if (type.type === "TSUnknownKeyword") return true;
    if (type.type === "TSParenthesizedType") return resolves(type.typeAnnotation, policy, visited);
    if (policy.includeUnions && type.type === "TSUnionType") {
      return type.types.some((member) => resolves(member, policy, visited));
    }
    if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return false;

    const name = type.typeName.name;
    const typeParameterScopes = policy.typeParameterScopes(type);
    if (
      policy.includePromises &&
      (name === "Promise" || name === "PromiseLike") &&
      !hasLocalTypeName(type, name, typeParameterScopes)
    ) {
      const value = type.typeArguments?.params[0];
      return value !== undefined && resolves(value, policy, visited);
    }

    const alias = findAlias(type, typeParameterScopes);
    if (
      alias === null ||
      hasTypeArguments(type) ||
      alias.typeParameters !== null ||
      visited.has(alias)
    ) {
      return false;
    }
    const nextVisited = new Set(visited).add(alias);
    return resolves(alias.typeAnnotation, policy, nextVisited);
  };

  return {
    /** Resolve a type under the caller's alias and scope policy. */
    resolvesToUnknown(type, policy) {
      return resolves(type, policy, new Set());
    },
  };
}
