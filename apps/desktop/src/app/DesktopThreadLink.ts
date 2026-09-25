import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// `t3code://thread/<environmentId>/<threadId>` shows an existing thread in the
// running app. Linux and Windows deliver it as a launch argument, to the
// second instance's `second-instance` event when the app is already running;
// macOS delivers it through `open-url`.
const THREAD_LINK_HOST = "thread";

// Anyone can hand the app a link, so it names a thread and nothing else: each
// identifier is one path segment of URL-safe characters that is never decoded,
// and anything more (a query, a fragment, another segment) is not a thread link.
const THREAD_LINK_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface DesktopThreadLinkTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export function parseThreadLink(
  value: string,
  scheme: string,
): Option.Option<DesktopThreadLinkTarget> {
  const prefix = `${scheme}://${THREAD_LINK_HOST}/`;
  if (!value.startsWith(prefix)) return Option.none();
  const segments = value.slice(prefix.length).split("/");
  if (segments.length !== 2) return Option.none();
  const [environmentId = "", threadId = ""] = segments;
  if (!THREAD_LINK_ID.test(environmentId) || !THREAD_LINK_ID.test(threadId)) {
    return Option.none();
  }
  return Option.some({
    environmentId: EnvironmentId.make(environmentId),
    threadId: ThreadId.make(threadId),
  });
}

/** The thread link among a launch's arguments, if one names a thread. */
export function findThreadLink(
  argv: ReadonlyArray<string>,
  scheme: string,
): Option.Option<DesktopThreadLinkTarget> {
  for (const argument of argv) {
    const target = parseThreadLink(argument, scheme);
    if (Option.isSome(target)) return target;
  }
  return Option.none();
}

export class DesktopThreadLink extends Context.Service<
  DesktopThreadLink,
  {
    /** Opens a thread link in `argv`, the app's own launch arguments, and any delivered later. */
    readonly register: (argv: ReadonlyArray<string>) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/app/DesktopThreadLink") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-thread-link");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const activation = yield* DesktopAppActivation.DesktopAppActivation;
  const crypto = yield* Crypto.Crypto;
  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);

  // The activation broker focuses the window and holds the request until the
  // renderer is ready, which on a cold start is after the backend connects.
  const open = (target: DesktopThreadLinkTarget) =>
    Effect.gen(function* () {
      yield* electronApp.whenReady;
      const requestId = yield* crypto.randomUUIDv4;
      const response = yield* activation.request({
        version: 1,
        requestId,
        type: "open-thread",
        ...target,
      });
      yield* response.ok
        ? logInfo("opened thread link", { ...target })
        : logWarning("thread link was not opened", {
            ...target,
            code: response.code,
            message: response.message,
          });
    }).pipe(
      Effect.catchCause((cause) => logWarning("thread link failed", { ...target, cause })),
      Effect.withSpan("desktop.threadLink.open"),
    );

  return DesktopThreadLink.of({
    register: Effect.fn("desktop.threadLink.register")(function* (argv) {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      yield* electronApp.on("second-instance", (_event: Electron.Event, secondArgv: unknown) => {
        if (!Array.isArray(secondArgv)) return;
        const target = findThreadLink(secondArgv as ReadonlyArray<string>, scheme);
        if (Option.isSome(target)) runFork(open(target.value));
      });
      yield* electronApp.on("open-url", (event: Electron.Event, url: unknown) => {
        if (typeof url !== "string") return;
        const target = parseThreadLink(url, scheme);
        if (Option.isNone(target)) return;
        event.preventDefault();
        runFork(open(target.value));
      });
      const launched = findThreadLink(argv, scheme);
      if (Option.isSome(launched)) {
        yield* Effect.forkScoped(open(launched.value));
      }
    }),
  });
});

export const layer = Layer.effect(DesktopThreadLink, make);
