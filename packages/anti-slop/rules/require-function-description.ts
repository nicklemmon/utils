import type { ESTree } from "@oxlint/plugins";

import { defineRule } from "@oxlint/plugins";

/** Check whether a JSDoc block starts with a summary line. */
function hasSummary(comment: string): boolean {
  const lines = comment
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/u, "").trim())
    .filter((line) => line.length > 0);
  const firstLine = lines.find((line) => line.length > 0);
  return firstLine !== undefined && !firstLine.startsWith("@");
}

/** Require a short JSDoc description on named functions and class methods. */
export const requireFunctionDescriptionRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require a JSDoc description for named functions and class methods." },
    messages: {
      missingDescription: "Add a short JSDoc description for this function.",
      redundantType: "Remove JSDoc types. TypeScript already declares this function's types.",
    },
  },
  /** Create visitors that check named functions and methods. */
  create(context) {
    /** Check a function or method's JSDoc summary and type tags. */
    const check = (node: ESTree.Node) => {
      const docTarget =
        node.parent?.type === "ExportNamedDeclaration" ||
        node.parent?.type === "ExportDefaultDeclaration"
          ? node.parent
          : node;
      const comments = context.sourceCode.getCommentsBefore(docTarget);
      let commentIndex = comments.length - 1;
      let comment = comments.at(commentIndex);
      while (comment?.type === "Line" && /^\s*oxlint-disable-next-line\b/u.test(comment.value)) {
        commentIndex -= 1;
        comment = comments.at(commentIndex);
      }
      if (
        comment === undefined ||
        comment.type !== "Block" ||
        !comment.value.trimStart().startsWith("*") ||
        !hasSummary(comment.value)
      ) {
        context.report({ node, messageId: "missingDescription" });
        return;
      }
      const commentText = context.sourceCode.getText(comment);
      if (/^\s*\*?\s*@(param|arg|argument|returns?|return)\s+\{[^}]+\}/mu.test(commentText))
        context.report({ node, messageId: "redundantType" });
    };

    return {
      /** Check named function declarations. */
      FunctionDeclaration(node) {
        if (node.id !== null) check(node);
      },
      /** Check named ambient function declarations. */
      TSDeclareFunction(node) {
        if (node.id !== null) check(node);
      },
      /** Check named functions assigned to identifiers. */
      VariableDeclaration(node) {
        const namedFunction = node.declarations.some(
          (declaration) =>
            (declaration.init?.type === "ArrowFunctionExpression" ||
              declaration.init?.type === "FunctionExpression") &&
            declaration.id.type === "Identifier",
        );
        if (namedFunction) check(node);
      },
      /** Check class methods. */
      MethodDefinition(node) {
        if (node.value.type === "FunctionExpression") check(node);
      },
      TSMethodSignature: check,
      /** Check object methods and function-valued properties. */
      Property(node) {
        if (
          node.method ||
          node.value.type === "ArrowFunctionExpression" ||
          node.value.type === "FunctionExpression"
        )
          check(node);
      },
      /** Check function-valued class properties. */
      PropertyDefinition(node) {
        if (
          node.value?.type === "ArrowFunctionExpression" ||
          node.value?.type === "FunctionExpression"
        )
          check(node);
      },
    };
  },
});
