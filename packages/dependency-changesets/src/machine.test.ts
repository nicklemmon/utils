import { describe, expect, it } from "vitest";

import type { ChangesetServices } from "./machine.ts";
import type { ChangesetSource } from "./plan.ts";

import { runChangesets } from "./machine.ts";
import { planChangeset } from "./plan.ts";

type Fixture = {
  services: { -readonly [Key in keyof ChangesetServices]: ChangesetServices[Key] };
  source: { -readonly [Key in keyof ChangesetSource]: ChangesetSource[Key] };
  calls: string[];
};

function fixture(): Fixture {
  const calls: string[] = [];
  const source: Fixture["source"] = {
    number: 40,
    head: "captured-head",
    branch: "dependabot/update",
    ignored: [],
    existing: undefined,
    packages: [
      {
        path: "packages/gh-gl/package.json",
        before: '{"name":"gh-gl","dependencies":{"execa":"^10.0.1"}}',
        after: '{"name":"gh-gl","dependencies":{"execa":"^10.1.0"}}',
      },
    ],
  };
  return {
    source,
    calls,
    services: {
      load: async () => {
        calls.push("load");
        await Promise.resolve();
        return source;
      },
      verify: async (input) => {
        calls.push(`verify:${input.head}`);
        await Promise.resolve();
      },
      publish: async (input, plan) => {
        calls.push(`publish:${input.head}:${plan.path}`);
        await Promise.resolve();
      },
    },
  };
}

describe("changeset machine", () => {
  it("verifies the captured head before publishing the plan", async () => {
    const { services, calls, source } = fixture();
    expect(await runChangesets(services, "publish")).toEqual({
      status: "published",
      plan: planChangeset(source),
      error: undefined,
    });
    expect(calls).toEqual([
      "load",
      "verify:captured-head",
      "publish:captured-head:.changeset/dependabot-40.md",
    ]);
  });

  it("previews without verification or writes", async () => {
    const { services, calls, source } = fixture();
    expect(await runChangesets(services, "preview")).toEqual({
      status: "preview",
      plan: planChangeset(source),
      error: undefined,
    });
    expect(calls).toEqual(["load"]);
  });

  it("skips publication when the plan is unchanged", async () => {
    const { services, calls, source } = fixture();
    source.existing =
      '---\n"gh-gl": patch\n---\n\nUpdate runtime dependencies in "gh-gl".\n\n- Update "execa" from "^10.0.1" to "^10.1.0".\n';
    expect((await runChangesets(services, "publish")).status).toBe("unchanged");
    expect(calls).toEqual(["load"]);
  });

  it("reports a missing changeset in check mode without verifying or writing", async () => {
    const { services, calls } = fixture();
    const result = await runChangesets(services, "check");
    expect(result.status).toBe("outdated");
    expect(calls).toEqual(["load"]);
  });

  it("accepts a current changeset in check mode", async () => {
    const { services, calls, source } = fixture();
    source.existing =
      '---\n"gh-gl": patch\n---\n\nUpdate runtime dependencies in "gh-gl".\n\n- Update "execa" from "^10.0.1" to "^10.1.0".\n';
    const result = await runChangesets(services, "check");
    expect(result.status).toBe("unchanged");
    expect(calls).toEqual(["load"]);
  });

  it("stops when loading fails", async () => {
    const { services, calls } = fixture();
    services.load = async (): Promise<ChangesetSource> => {
      await Promise.resolve();
      throw new Error("Not a Dependabot PR");
    };
    expect(await runChangesets(services, "publish")).toEqual({
      status: "failed",
      plan: undefined,
      error: "Not a Dependabot PR",
    });
    expect(calls).toEqual([]);
  });

  it("stops when planning fails", async () => {
    const { services, calls, source } = fixture();
    source.packages = [
      { path: "packages/invalid/package.json", before: '{"name":"old"}', after: '{"name":"new"}' },
    ];
    expect(await runChangesets(services, "publish")).toEqual({
      status: "failed",
      plan: undefined,
      error: "Package identity changed: packages/invalid/package.json",
    });
    expect(calls).toEqual(["load"]);
  });

  it("waits for verification and stops on a head change without publishing", async () => {
    const { services, calls } = fixture();
    const verification = Promise.withResolvers<boolean>();
    const entered = Promise.withResolvers<boolean>();
    services.verify = async (): Promise<void> => {
      entered.resolve(true);
      await verification.promise;
    };
    const pending = runChangesets(services, "publish");
    await entered.promise;
    expect(calls).toEqual(["load"]);
    verification.reject(new Error("PR head changed"));
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("PR head changed");
    expect(calls).toEqual(["load"]);
  });

  it("reports a write rejection without retrying the mutation", async () => {
    const { services, calls } = fixture();
    services.publish = async (): Promise<void> => {
      calls.push("write rejected");
      await Promise.reject(new Error("Non-fast-forward"));
    };
    const result = await runChangesets(services, "publish");
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Non-fast-forward");
    expect(calls).toEqual(["load", "verify:captured-head", "write rejected"]);
  });
});
