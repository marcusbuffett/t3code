import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopThreadLink from "./DesktopThreadLink.ts";

const environmentId = EnvironmentId.make("2a1e4666-aadd-4a1c-93f4-e4911f4e55fd");
const threadId = ThreadId.make("dc6bf21f-f576-4e47-a530-01d93066f3fb");
const link = `t3code://thread/${environmentId}/${threadId}`;

describe("parseThreadLink", () => {
  it("reads the environment and thread of a thread link", () => {
    assert.deepEqual(
      DesktopThreadLink.parseThreadLink(link, "t3code"),
      Option.some({ environmentId, threadId }),
    );
    assert.deepEqual(
      DesktopThreadLink.parseThreadLink("t3code-dev://thread/env_1/thread-1", "t3code-dev"),
      Option.some({ environmentId: "env_1", threadId: "thread-1" }),
    );
  });

  it("names a thread and nothing else", () => {
    for (const value of [
      // another build's scheme, the renderer origin, and the OAuth callback
      `t3code-dev://thread/${environmentId}/${threadId}`,
      `t3code://app/${environmentId}/${threadId}`,
      "t3code://app/",
      `T3CODE://thread/${environmentId}/${threadId}`,
      `t3code://thread/${environmentId}`,
      `t3code://thread/${environmentId}/`,
      `t3code://thread//${threadId}`,
      `${link}/`,
      `${link}/settings`,
      `${link}?redirect=https://example.com`,
      `${link}#top`,
      `t3code://thread/${environmentId}/..`,
      `t3code://thread/${environmentId}/%2e%2e`,
      `t3code://thread/${environmentId}/a%2Fb`,
      `t3code://thread/${environmentId}/a.b`,
      `t3code://thread/${environmentId}/a b`,
      `t3code://thread/${environmentId}/${"a".repeat(129)}`,
      `t3code://user@thread/${environmentId}/${threadId}`,
      `t3code://thread:80/${environmentId}/${threadId}`,
      `https://thread/${environmentId}/${threadId}`,
      "",
    ]) {
      assert.isTrue(Option.isNone(DesktopThreadLink.parseThreadLink(value, "t3code")), value);
    }
  });

  it("finds the link among launch arguments", () => {
    assert.deepEqual(
      DesktopThreadLink.findThreadLink(["/opt/t3code", "--no-sandbox", link], "t3code"),
      Option.some({ environmentId, threadId }),
    );
    assert.isTrue(
      Option.isNone(DesktopThreadLink.findThreadLink(["/opt/t3code", "t3code://app/"], "t3code")),
    );
  });
});

type Listener = (...args: ReadonlyArray<unknown>) => void;

const makeHarness = () => {
  const listeners = new Map<string, Listener>();
  const requests: DesktopAppActivationRequest[] = [];
  const electronApp = {
    whenReady: Effect.void,
    on: (eventName: string, listener: Listener) =>
      Effect.sync(() => {
        listeners.set(eventName, listener);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];
  const activation = {
    request: (request: DesktopAppActivationRequest) =>
      Effect.sync((): DesktopAppActivationResponse => {
        requests.push(request);
        return {
          version: 1,
          requestId: request.requestId,
          ok: false,
          code: "thread-not-found",
          message: "T3 Code does not know that thread.",
        };
      }),
  } as unknown as DesktopAppActivation.DesktopAppActivation["Service"];
  const environment = {
    isDevelopment: false,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];
  const layer = DesktopThreadLink.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(DesktopAppActivation.DesktopAppActivation, activation),
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        NodeServices.layer,
      ),
    ),
  );
  return { listeners, requests, layer };
};

const openThreadRequests = (requests: ReadonlyArray<DesktopAppActivationRequest>) =>
  requests.map((request) =>
    request.type === "open-thread"
      ? { type: request.type, environmentId: request.environmentId, threadId: request.threadId }
      : { type: request.type },
  );

// Forked opens run on the default scheduler; let them finish before asserting.
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
});

describe("DesktopThreadLink", () => {
  it.effect("opens the thread a cold start was launched with", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const threadLink = yield* DesktopThreadLink.DesktopThreadLink;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* threadLink.register(["/opt/t3code", link]);
          yield* settle;
        }),
      );
      assert.deepEqual(openThreadRequests(harness.requests), [
        { type: "open-thread", environmentId, threadId },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("opens a second launch's thread in the running app", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const threadLink = yield* DesktopThreadLink.DesktopThreadLink;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* threadLink.register(["/opt/t3code"]);
          const secondInstance = harness.listeners.get("second-instance");
          assert.isDefined(secondInstance);
          // The OAuth callback belongs to Clerk's bridge, not to this handler.
          secondInstance?.({}, ["/opt/t3code", "t3code://app/?code=1"], "/home");
          secondInstance?.({}, ["/opt/t3code", "--no-sandbox", link], "/home");
          yield* settle;
        }),
      );
      assert.deepEqual(openThreadRequests(harness.requests), [
        { type: "open-thread", environmentId, threadId },
      ]);
      const [request] = harness.requests;
      assert.equal(request?.version, 1);
      assert.isAbove(request?.requestId.length ?? 0, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("claims only thread links delivered through open-url", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const threadLink = yield* DesktopThreadLink.DesktopThreadLink;
      const prevented: string[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* threadLink.register([]);
          const openUrl = harness.listeners.get("open-url");
          for (const url of ["t3code://app/?code=1", link]) {
            openUrl?.({ preventDefault: () => prevented.push(url) }, url);
          }
          yield* settle;
        }),
      );
      assert.deepEqual(prevented, [link]);
      assert.deepEqual(openThreadRequests(harness.requests), [
        { type: "open-thread", environmentId, threadId },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ignores a launch without a thread link", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const threadLink = yield* DesktopThreadLink.DesktopThreadLink;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* threadLink.register(["/opt/t3code", `${link}?x=1`]);
          yield* settle;
        }),
      );
      assert.deepEqual(harness.requests, []);
    }).pipe(Effect.provide(harness.layer));
  });
});
