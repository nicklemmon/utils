import type { ESTree } from "@oxlint/plugins";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

type NodeCandidate = {
  readonly type?: string;
};

function isNode(value: NodeCandidate | null | undefined): value is ESTree.Node {
  return value !== null && value !== undefined && typeof value.type === "string";
}

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
export function lexicalTypeParameterNames(
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
): ReadonlySet<string> {
  const names = new Set<string>();
  let descendant: ESTree.Node = node;
  let current: ESTree.Node | null = node;
  while (current !== null && current.type !== "Program") {
    if ("typeParameters" in current) {
      for (const parameter of current.typeParameters?.params ?? []) {
        names.add(parameter.name.name);
      }
    }
    if (
      current.type === "TSMappedType" &&
      (descendant === current.nameType || descendant === current.typeAnnotation)
    ) {
      names.add(current.key.name);
    }
    if (current.type === "TSConditionalType" && descendant === current.trueType) {
      collectInferTypeParameterNames(current.extendsType, visitorKeys, names);
    }
    descendant = current;
    current = current.parent;
  }
  return names;
}
