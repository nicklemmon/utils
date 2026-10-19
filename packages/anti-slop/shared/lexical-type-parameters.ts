import type { ESTree } from "@oxlint/plugins";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

type NodeCandidate = {
  readonly type?: string;
};

/** Return whether a value is an ESTree node. */
function isNode(value: NodeCandidate | null | undefined): value is ESTree.Node {
  return value !== null && value !== undefined && typeof value.type === "string";
}

/** Visit each child node and collect names declared by infer types. */
function visitChildNodes(
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
  visit: (child: ESTree.Node) => void,
): void {
  const keys = visitorKeys[node.type];
  if (keys === undefined) return;
  for (const key of keys) {
    if (!Object.hasOwn(node, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor === undefined) continue;
    // Visitor keys index untyped ESTree child slots.
    // oxlint-disable-next-line typescript/no-unsafe-assignment
    const value = descriptor.value;
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Visitor keys index untyped ESTree child slots.
    if (isNode(value)) {
      visit(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const child of value) {
      // oxlint-disable-next-line typescript/no-unsafe-argument -- Visitor keys index untyped ESTree child slots.
      if (isNode(child)) visit(child);
    }
  }
}

/** Collect type parameter names introduced by `infer`. */
function collectInferTypeParameterNames(
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
  names: Set<string>,
): void {
  if (node.type === "TSInferType") names.add(node.typeParameter.name.name);
  visitChildNodes(node, visitorKeys, (child) => {
    collectInferTypeParameterNames(child, visitorKeys, names);
  });
}

/**
 * Collect type binders that are in scope at a node and can shadow module aliases.
 *
 * @param node - AST node whose enclosing type parameters should be collected.
 * @param visitorKeys - Visitor keys used to walk infer type parameter nodes.
 * @returns Names of type parameters that shadow aliases at `node`.
 */
/** Collect type parameters in scope that can shadow module aliases. */
export function lexicalTypeParameterNames(
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
): ReadonlySet<string> {
  return new Set(lexicalTypeParameterScopes(node, visitorKeys).keys());
}

/**
 * Find the nearest declaration node for each type binder that is in scope at a node.
 *
 * @param node - AST node whose enclosing type parameters should be collected.
 * @param visitorKeys - Visitor keys used to walk infer type parameter nodes.
 * @returns The nearest binder node for each bound name.
 */
export function lexicalTypeParameterScopes(
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
): ReadonlyMap<string, ESTree.Node> {
  const scopes = new Map<string, ESTree.Node>();
  let descendant: ESTree.Node = node;
  let current: ESTree.Node | null = node;
  while (current !== null && current.type !== "Program") {
    if ("typeParameters" in current) {
      for (const parameter of current.typeParameters?.params ?? []) {
        if (!scopes.has(parameter.name.name)) scopes.set(parameter.name.name, current);
      }
    }
    if (
      current.type === "TSMappedType" &&
      (descendant === current.nameType || descendant === current.typeAnnotation) &&
      !scopes.has(current.key.name)
    ) {
      scopes.set(current.key.name, current);
    }
    if (current.type === "TSConditionalType" && descendant === current.trueType) {
      const inferNames = new Set<string>();
      collectInferTypeParameterNames(current.extendsType, visitorKeys, inferNames);
      for (const name of inferNames) {
        if (!scopes.has(name)) scopes.set(name, current);
      }
    }
    descendant = current;
    current = current.parent;
  }
  return scopes;
}
