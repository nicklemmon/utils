import type { ESTree } from "@oxlint/plugins";

import { defineRule } from "@oxlint/plugins";

import { lexicalTypeParameterScopes } from "../shared/lexical-type-parameters.ts";
import { createTypeAliasResolver } from "../shared/type-alias-resolver.ts";

type FunctionWithReturnType =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
    },
  },
  /** Create visitors that detect functions returning `unknown`. */
  createOnce(context) {
    const aliases: ESTree.TSTypeAliasDeclaration[] = [];
    const shadowingDeclarations: ESTree.Node[] = [];
    const functions: FunctionWithReturnType[] = [];

    return {
      /** Reset collected declarations before scanning the file. */
      Program() {
        aliases.length = 0;
        shadowingDeclarations.length = 0;
        functions.length = 0;
      },
      /** Collect aliases for return type resolution. */
      TSTypeAliasDeclaration(node) {
        aliases.push(node);
      },
      /** Collect interfaces that can shadow type aliases. */
      TSInterfaceDeclaration(node) {
        shadowingDeclarations.push(node);
      },
      /** Collect classes that can shadow type aliases. */
      ClassDeclaration(node) {
        if (node.id !== null) shadowingDeclarations.push(node);
      },
      /** Collect imports that can shadow type aliases. */
      ImportDeclaration(node) {
        shadowingDeclarations.push(node);
      },
      /** Collect arrow functions for return type checks. */
      ArrowFunctionExpression(node) {
        functions.push(node);
      },
      /** Collect function declarations for return type checks. */
      FunctionDeclaration(node) {
        functions.push(node);
      },
      /** Collect function expressions for return type checks. */
      FunctionExpression(node) {
        functions.push(node);
      },
      /** Collect call signatures for return type checks. */
      TSCallSignatureDeclaration(node) {
        functions.push(node);
      },
      /** Collect construct signatures for return type checks. */
      TSConstructSignatureDeclaration(node) {
        functions.push(node);
      },
      /** Collect constructor types for return type checks. */
      TSConstructorType(node) {
        functions.push(node);
      },
      /** Collect ambient functions for return type checks. */
      TSDeclareFunction(node) {
        functions.push(node);
      },
      /** Collect functions without bodies for return type checks. */
      TSEmptyBodyFunctionExpression(node) {
        functions.push(node);
      },
      /** Collect function types for return type checks. */
      TSFunctionType(node) {
        functions.push(node);
      },
      /** Collect method signatures for return type checks. */
      TSMethodSignature(node) {
        functions.push(node);
      },
      /** Resolve collected return types after reading all declarations. */
      "Program:exit"() {
        const resolver = createTypeAliasResolver(aliases, shadowingDeclarations);
        for (const node of functions) {
          const annotation = node.returnType;
          if (annotation === null || annotation === undefined) continue;
          if (
            !resolver.resolvesToUnknown(annotation.typeAnnotation, {
              includeUnions: true,
              includePromises: true,
              /** Find type parameters that shadow aliases at this reference. */
              typeParameterScopes: (type) =>
                lexicalTypeParameterScopes(type, context.sourceCode.visitorKeys),
            })
          ) {
            continue;
          }
          context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
        }
      },
    };
  },
});
