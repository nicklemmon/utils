import type { ESTree } from "@oxlint/plugins";

import { defineRule } from "@oxlint/plugins";

import { lexicalTypeParameterScopes } from "../shared/lexical-type-parameters.ts";
import { createTypeAliasResolver } from "../shared/type-alias-resolver.ts";

/** Ban named aliases that merely conceal TypeScript's unknown top type. */
export const noUnknownTypeAliasesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
    },
    messages: {
      unknownAlias:
        "Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
    },
  },
  /** Create visitors that detect aliases resolving to `unknown`. */
  createOnce(context) {
    const aliases: ESTree.TSTypeAliasDeclaration[] = [];
    const shadowingDeclarations: ESTree.Node[] = [];

    return {
      /** Reset collected declarations before scanning the file. */
      Program() {
        aliases.length = 0;
        shadowingDeclarations.length = 0;
      },
      /** Collect aliases that may resolve to `unknown`. */
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
      /** Resolve collected aliases after reading all declarations. */
      "Program:exit"() {
        const resolver = createTypeAliasResolver(aliases, shadowingDeclarations);
        for (const alias of aliases) {
          if (
            !resolver.resolvesToUnknown(alias.typeAnnotation, {
              includeUnions: false,
              includePromises: false,
              typeParameterScopes(type) {
                const scopes = new Map(
                  lexicalTypeParameterScopes(type, context.sourceCode.visitorKeys),
                );
                for (const parameter of alias.typeParameters?.params ?? []) {
                  if (!scopes.has(parameter.name.name)) {
                    scopes.set(parameter.name.name, alias);
                  }
                }
                return scopes;
              },
            })
          ) {
            continue;
          }
          context.report({
            node: alias.id,
            messageId: "unknownAlias",
            data: { alias: alias.id.name },
          });
        }
      },
    };
  },
});
