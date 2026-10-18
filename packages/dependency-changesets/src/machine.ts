import type { DoneActorEvent, ErrorActorEvent } from "xstate";

import { assign, createActor, fromPromise, setup, toPromise } from "xstate";
import { z } from "zod";

import type { ChangesetPlan, ChangesetSource } from "./plan.ts";

import { planChangeset } from "./plan.ts";

/** Effects run by the changeset state machine. */
export type ChangesetServices = Readonly<{
  load: () => Promise<ChangesetSource>;
  verify: (source: ChangesetSource) => Promise<void>;
  publish: (source: ChangesetSource, plan: ChangesetPlan) => Promise<void>;
}>;

type Context = Readonly<{
  source: ChangesetSource | undefined;
  plan: ChangesetPlan | undefined;
  error: string | undefined;
}>;

type ContextInput = Readonly<{ context: Context }>;
type CompletionInput<Output> = Readonly<{ event: Readonly<DoneActorEvent<Output>> }>;
type FailureInput = Readonly<{ event: Readonly<ErrorActorEvent> }>;

/** Terminal outcome of a changeset run. Preview runs never publish. */
export type ChangesetResult = {
  status: "unchanged" | "preview" | "outdated" | "published" | "failed";
  plan: ChangesetPlan | undefined;
  error: string | undefined;
};

/** Preview a plan, check the generated file, or publish it. */
export type ChangesetMode = "preview" | "check" | "publish";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Actor errors enter from external effects.
function describeError(error: unknown): string {
  const parsed = z.object({ message: z.string() }).safeParse(error);
  return parsed.success
    ? parsed.data.message
    : "Changeset generation failed without an error message";
}

function requireSource(context: Context): ChangesetSource {
  if (!context.source) {
    throw new Error("Changeset source is missing");
  }
  return context.source;
}

function requirePlan(context: Context): ChangesetPlan {
  if (!context.plan) {
    throw new Error("Changeset plan is missing");
  }
  return context.plan;
}

/**
 * Run each effect in order. Stop on errors and leave retries to a new run.
 *
 * @param services - Effects invoked by the machine. Mutations are never retried.
 * @param mode - Preview and check modes never publish. Check mode reports stale files.
 * @returns The final outcome, including the error message when an effect fails.
 */
export async function runChangesets(
  services: ChangesetServices,
  mode: ChangesetMode,
): Promise<ChangesetResult> {
  const initialContext: Context = { source: undefined, plan: undefined, error: undefined };
  const machine = setup({
    types: { context: initialContext },
    actors: {
      load: fromPromise(async () => {
        const source = await services.load();
        return source;
      }),
      plan: fromPromise(async ({ input }: Readonly<{ input: ChangesetSource }>) => {
        const plan = await Promise.resolve(planChangeset(input));
        return plan;
      }),
      verify: fromPromise(async ({ input }: Readonly<{ input: ChangesetSource }>) => {
        await services.verify(input);
      }),
      publish: fromPromise(async ({ input }: Readonly<{ input: Context }>) => {
        await services.publish(requireSource(input), requirePlan(input));
      }),
    },
  }).createMachine({
    id: "dependencyChangesets",
    context: initialContext,
    initial: "loading",
    states: {
      loading: {
        invoke: {
          src: "load",
          onDone: {
            target: "planning",
            actions: assign({
              source: ({ event }: CompletionInput<ChangesetSource>) => event.output,
            }),
          },
          onError: {
            target: "failed",
            actions: assign({ error: ({ event }: FailureInput) => describeError(event.error) }),
          },
        },
      },
      planning: {
        invoke: {
          src: "plan",
          input: ({ context }: ContextInput) => requireSource(context),
          onDone: {
            target: "deciding",
            actions: assign({ plan: ({ event }: CompletionInput<ChangesetPlan>) => event.output }),
          },
          onError: {
            target: "failed",
            actions: assign({ error: ({ event }: FailureInput) => describeError(event.error) }),
          },
        },
      },
      deciding: {
        always: [
          {
            guard: ({ context }: ContextInput): boolean => !requirePlan(context).changed,
            target: "unchanged",
          },
          { guard: (): boolean => mode === "preview", target: "preview" },
          { guard: (): boolean => mode === "check", target: "outdated" },
          { target: "verifying" },
        ],
      },
      verifying: {
        invoke: {
          src: "verify",
          input: ({ context }: ContextInput) => requireSource(context),
          onDone: "publishing",
          onError: {
            target: "failed",
            actions: assign({ error: ({ event }: FailureInput) => describeError(event.error) }),
          },
        },
      },
      publishing: {
        invoke: {
          src: "publish",
          input: ({ context }: ContextInput) => context,
          onDone: "published",
          onError: {
            target: "failed",
            actions: assign({ error: ({ event }: FailureInput) => describeError(event.error) }),
          },
        },
      },
      unchanged: { type: "final" },
      preview: { type: "final" },
      outdated: { type: "final" },
      published: { type: "final" },
      failed: { type: "final" },
    },
  });
  const actor = createActor(machine);
  actor.start();
  try {
    await toPromise(actor);
    const snapshot = actor.getSnapshot();
    return {
      status: z
        .enum(["unchanged", "preview", "outdated", "published", "failed"])
        .parse(snapshot.value),
      plan: snapshot.context.plan,
      error: snapshot.context.error,
    };
  } finally {
    actor.stop();
  }
}
