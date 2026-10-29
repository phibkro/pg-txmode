import { NodeServices } from "@effect/platform-node";
import { Effect, Option, Ref, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** What a script printed, and whether it ended before the deadline (a hang is `finished: false`). */
export interface Outcome {
  readonly lines: readonly string[];
  readonly finished: boolean;
}

/**
 * Runs a script with `bun` as a process of its own and reads its standard output until it ends or `deadline` passes; the
 * process is killed when the effect ends. A client that hangs cannot be interrupted from inside (its interruption waits for
 * the very operation that never answers), so a test observes a hang from outside.
 */
export const runScript = (
  file: string,
  env: Readonly<Record<string, string>>,
  deadline: "10 seconds" | "20 seconds"
): Effect.Effect<Outcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const lines = yield* Ref.make<readonly string[]>([]);

    const finished = yield* spawner
      .spawn(
        ChildProcess.make("bun", [file], {
          env,
          extendEnv: true,
          forceKillAfter: "2 seconds",
        })
      )
      .pipe(
        Effect.flatMap((handle) =>
          handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Ref.update(lines, (seen) => [...seen, line])
            ),
            Effect.timeoutOption(deadline)
          )
        ),
        Effect.scoped,
        Effect.orDie
      );

    return { finished: Option.isSome(finished), lines: yield* Ref.get(lines) };
  });

/** The child-process layer of Node: the one place that picks the platform for the scripts a test runs. */
export const processes = NodeServices.layer;
