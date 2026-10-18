import type { ESTree } from "@oxlint/plugins";

import { defineRule } from "@oxlint/plugins";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

type TypeofRuleOption = {
  readonly allowInTypeGuards: boolean;
};

type JsonRecord = {
  readonly allowInTypeGuards?: boolean;
};

/** Return whether a value is a record in the JSON rule options. */
function isJsonRecord(
  option: JsonRecord | string | number | boolean | null | undefined | readonly unknown[],
): option is JsonRecord {
  return Object.prototype.toString.call(option) === "[object Object]";
}

/** Return whether the rule option allows this `typeof` check. */
function isTypeofRuleOption(
  option: JsonRecord | string | number | boolean | null | undefined | readonly unknown[],
): option is TypeofRuleOption {
  return isJsonRecord(option) && "allowInTypeGuards" in option;
}

/** Return whether a node is a runtime function declaration or expression. */
function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  );
}

/** Return whether a `typeof` check is already inside a type guard. */
function isInsideTypeGuard(node: ESTree.Node): boolean {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isRuntimeFunction(current)) {
      return current.returnType?.typeAnnotation.type === "TSTypePredicate";
    }
    current = current.parent;
  }
  return false;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
    },
    messages: {
      runtimeTypeof:
        "A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowInTypeGuards: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowInTypeGuards: false }],
  },
  /** Register a visitor that checks runtime `typeof` expressions. */
  createOnce(context) {
    return {
      /** Report a `typeof` check on an unparsed value. */
      UnaryExpression(node) {
        const option = context.options[0];
        const allowInTypeGuards = isTypeofRuleOption(option) && option.allowInTypeGuards;
        if (node.operator === "typeof" && (!allowInTypeGuards || !isInsideTypeGuard(node))) {
          context.report({ node, messageId: "runtimeTypeof" });
        }
      },
    };
  },
});
