import { describe, expect, it } from "vitest";

import type { ChangesetSource, PackageChange } from "./plan.ts";

import { planChangeset } from "./plan.ts";

type TestSource = { -readonly [Key in keyof ChangesetSource]: ChangesetSource[Key] };
type TestChange = { -readonly [Key in keyof PackageChange]: PackageChange[Key] };

function source(packages: readonly PackageChange[] = []): TestSource {
  return {
    number: 40,
    head: "head",
    branch: "dependabot/update",
    ignored: [],
    packages,
    existing: undefined,
  };
}

function update(
  name: string,
  options: Readonly<{ private?: boolean; dev?: boolean }> = {},
): TestChange {
  const field = options.dev === true ? "devDependencies" : "dependencies";
  return {
    path: `packages/${name}/package.json`,
    before: JSON.stringify({
      name,
      private: options.private ?? false,
      [field]: { execa: "^10.0.1" },
    }),
    after: JSON.stringify({
      name,
      private: options.private ?? false,
      [field]: { execa: "^10.1.0" },
    }),
  };
}

describe("planChangeset", () => {
  it("generates one patch per affected public package in a stable order", () => {
    expect(planChangeset(source([update("second"), update("first")]))).toEqual({
      path: ".changeset/dependabot-40.md",
      changed: true,
      content:
        '---\n"first": patch\n"second": patch\n---\n\nUpdate runtime dependencies in "first".\n\n- Update "execa" from "^10.0.1" to "^10.1.0".\n\nUpdate runtime dependencies in "second".\n\n- Update "execa" from "^10.0.1" to "^10.1.0".\n',
    });
  });

  it("skips private packages, ignored packages, and development dependencies in mixed groups", () => {
    const input = source([
      update("private", { private: true }),
      update("ignored"),
      update("dev", { dev: true }),
      update("public"),
    ]);
    input.ignored = ["ignored"];
    const expected = planChangeset(source([update("public")]));
    expect(planChangeset(input)).toEqual(expected);
  });

  it("does not commit again when the generated file already matches", () => {
    const input = source([update("public")]);
    input.existing =
      '---\n"public": patch\n---\n\nUpdate runtime dependencies in "public".\n\n- Update "execa" from "^10.0.1" to "^10.1.0".\n';
    expect(planChangeset(input).changed).toBe(false);
  });

  it("uses Changesets glob matching for ignored packages", () => {
    const input = source([update("@nicklemmon/gh-gl")]);
    input.ignored = ["@nicklemmon/*"];
    expect(planChangeset(input)).toEqual({
      path: ".changeset/dependabot-40.md",
      content: null,
      changed: false,
    });
  });

  it("lets a later negated pattern include a package again", () => {
    const input = source([update("@scope/public"), update("@scope/internal")]);
    input.ignored = ["@scope/*", "!@scope/public"];
    expect(planChangeset(input)).toEqual(planChangeset(source([update("@scope/public")])));
  });

  it("does not ignore packages when only a negated pattern is present", () => {
    const input = source([update("@scope/public")]);
    input.ignored = ["!@scope/internal"];
    expect(planChangeset(input)).toEqual(planChangeset(source([update("@scope/public")])));
  });

  it("lets a later positive pattern ignore a package again", () => {
    const input = source([update("@scope/public")]);
    input.ignored = ["@scope/*", "!@scope/public", "@scope/public"];
    expect(planChangeset(input)).toEqual({
      path: ".changeset/dependabot-40.md",
      content: null,
      changed: false,
    });
  });

  it("replaces the file when Dependabot changes the update", () => {
    const input = source([update("public")]);
    input.existing = '---\n"public": patch\n---\n\nOld update.\n';
    expect(planChangeset(input)).toEqual(planChangeset(source([update("public")])));
  });

  it("removes a stale generated file when no runtime updates remain", () => {
    const input = source();
    input.existing = "Previous generated file";
    expect(planChangeset(input)).toEqual({
      path: ".changeset/dependabot-40.md",
      content: null,
      changed: true,
    });
  });

  it("leaves lockfile-only and Actions updates unchanged", () => {
    expect(planChangeset(source())).toEqual({
      path: ".changeset/dependabot-40.md",
      content: null,
      changed: false,
    });
  });

  it("rejects peer dependency updates rather than choosing a release type", () => {
    const change = update("public");
    change.after = JSON.stringify({ name: "public", peerDependencies: { react: "^19" } });
    expect(() => planChangeset(source([change]))).toThrow(
      "Peer dependency changes need manual review: packages/public/package.json",
    );
  });

  it("rejects renamed packages", () => {
    const change = update("public");
    change.after = JSON.stringify({ name: "renamed" });
    expect(() => planChangeset(source([change]))).toThrow(
      "Package identity changed: packages/public/package.json",
    );
  });

  it("rejects dependency additions and removals", () => {
    const change = update("public");
    change.after = JSON.stringify({ name: "public" });
    expect(() => planChangeset(source([change]))).toThrow(
      "Dependency additions or removals need manual review: packages/public/package.json",
    );
  });

  it("rejects malformed dependency ranges at the JSON boundary", () => {
    const change = update("public");
    change.after = JSON.stringify({ name: "public", dependencies: { execa: 123 } });
    expect(() => planChangeset(source([change]))).toThrow(
      /Invalid input: expected string, received number/u,
    );
  });
});
