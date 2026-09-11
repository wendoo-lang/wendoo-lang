import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { WSContext } from "hono/ws";

process.env.BRIDGE_BINDING_SECRET = "session-registry-characterization-secret";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";

const bindingTokenModule = await import("#core/binding-token.js");
const sessionRegistry = await import("#core/session-registry.js");

bindingTokenModule.initBindingSecret();

// Mirrors the private DISCONNECTED_MAX_SIZE / DISCONNECTED_PURGE_TARGET pair in
// session-registry.ts; the purge fires once the cache exceeds the cap.
const DISCONNECTED_MAX_SIZE = 10_000;
const DISCONNECTED_PURGE_TARGET = 8_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface CloseRecord {
  code: number | undefined;
  reason: string | undefined;
}

interface TestWs {
  readonly ws: WSContext;
  readonly messages: string[];
  readonly closes: CloseRecord[];
}

interface AppStatusMessage {
  type: string;
  payload?: {
    bound?: boolean;
    bindingToken?: string;
    clientConnected?: boolean;
  };
}

function createTestWs(): TestWs {
  const messages: string[] = [];
  const closes: CloseRecord[] = [];
  const ws = {
    send(data: string) {
      messages.push(data);
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
    },
  } as unknown as WSContext;
  return { ws, messages, closes };
}

function statuses(testWs: TestWs): AppStatusMessage[] {
  return testWs.messages.map((data) => JSON.parse(data) as AppStatusMessage);
}

function lastStatus(testWs: TestWs): AppStatusMessage | undefined {
  return statuses(testWs).at(-1);
}

describe("session registry app registration", () => {
  beforeEach(() => {
    sessionRegistry.clearAllSessions();
  });

  it("gives each app session its own id, join code and binding id", () => {
    const firstWs = createTestWs();
    const secondWs = createTestWs();

    const first = sessionRegistry.registerAppSession(firstWs.ws);
    const second = sessionRegistry.registerAppSession(secondWs.ws);

    assert.equal(first.role, "app");
    assert.match(first.id, /^app_/);
    assert.match(first.bindingId, UUID_PATTERN);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.joinCode, second.joinCode);
    assert.notEqual(first.bindingId, second.bindingId);
    assert.deepEqual(sessionRegistry.getSessionCount(), { apps: 2, extensions: 0 });
    assert.equal(sessionRegistry.getAppByJoinCode(first.joinCode), first);
    assert.equal(sessionRegistry.getAppByBindingId(second.bindingId), second);
  });

  it("restores the binding id from a valid binding token", () => {
    const firstWs = createTestWs();
    const first = sessionRegistry.registerAppSession(firstWs.ws);
    const token = bindingTokenModule.createBindingToken(first.bindingId);
    sessionRegistry.discardAppSession(firstWs.ws);

    const secondWs = createTestWs();
    const second = sessionRegistry.registerAppSession(secondWs.ws, token);

    assert.equal(second.bindingId, first.bindingId);
    assert.notEqual(second.id, first.id);
  });

  it("generates a fresh binding id when the binding token fails verification", () => {
    const firstWs = createTestWs();
    const first = sessionRegistry.registerAppSession(firstWs.ws);
    const tampered = `${first.bindingId}.00000000`;
    sessionRegistry.discardAppSession(firstWs.ws);

    const malformedWs = createTestWs();
    const malformed = sessionRegistry.registerAppSession(malformedWs.ws, "no-dot-in-this-token");
    const tamperedWs = createTestWs();
    const resigned = sessionRegistry.registerAppSession(tamperedWs.ws, tampered);

    assert.match(malformed.bindingId, UUID_PATTERN);
    assert.notEqual(malformed.bindingId, first.bindingId);
    assert.match(resigned.bindingId, UUID_PATTERN);
    assert.notEqual(resigned.bindingId, first.bindingId);
  });

  it("replaces the previous app session when the same socket registers again", () => {
    const appWs = createTestWs();
    const first = sessionRegistry.registerAppSession(appWs.ws);
    const second = sessionRegistry.registerAppSession(appWs.ws);

    assert.equal(sessionRegistry.getAppSession(appWs.ws), second);
    assert.equal(sessionRegistry.getAllAppSessions().length, 1);
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.bindingId, first.bindingId);
    assert.equal(sessionRegistry.getAppByJoinCode(first.joinCode), undefined);
  });
});

describe("session registry extension registration", () => {
  beforeEach(() => {
    sessionRegistry.clearAllSessions();
  });

  it("binds to a live app when the join code matches, without sending an appStatus", () => {
    const appWs = createTestWs();
    const extensionWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);

    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, app.joinCode);

    assert.equal(extension.role, "extension");
    assert.match(extension.id, /^ext_/);
    assert.equal(extension.appSessionId, app.id);
    assert.equal(extension.bindingId, app.bindingId);
    assert.equal(extension.pendingJoinCode, undefined);
    assert.equal(extension.pendingBindingId, undefined);
    assert.deepEqual(extensionWs.messages, []);
    assert.deepEqual(sessionRegistry.getExtensionsByAppSessionId(app.id), [extension]);
  });

  it("leaves the extension pending when the join code is unknown", () => {
    const extensionWs = createTestWs();

    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, "unknown-join-code");

    assert.equal(extension.appSessionId, undefined);
    assert.equal(extension.bindingId, undefined);
    assert.equal(extension.pendingJoinCode, "unknown-join-code");
    assert.equal(extension.pendingBindingId, undefined);
  });

  it("records a pending binding id when the token verifies but no app is live", () => {
    const appWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);
    const token = bindingTokenModule.createBindingToken(app.bindingId);
    sessionRegistry.discardAppSession(appWs.ws);

    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, undefined, token);

    assert.equal(extension.appSessionId, undefined);
    assert.equal(extension.bindingId, app.bindingId);
    assert.equal(extension.pendingBindingId, app.bindingId);
    assert.equal(extension.pendingJoinCode, undefined);
  });

  it("neither binds nor pends when the binding token fails verification", () => {
    const appWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);
    const extensionWs = createTestWs();

    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, undefined, `${app.bindingId}.00000000`);

    assert.equal(extension.appSessionId, undefined);
    assert.equal(extension.bindingId, undefined);
    assert.equal(extension.pendingJoinCode, undefined);
    assert.equal(extension.pendingBindingId, undefined);
  });

  it("clears an unmatched pending join code when the binding token binds to a live app", () => {
    const appWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);
    const token = bindingTokenModule.createBindingToken(app.bindingId);

    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, "unknown-join-code", token);

    assert.equal(extension.appSessionId, app.id);
    assert.equal(extension.bindingId, app.bindingId);
    assert.equal(extension.pendingJoinCode, undefined);
    assert.equal(extension.pendingBindingId, undefined);
  });

  it("replaces the previous extension session when the same socket registers again", () => {
    const extensionWs = createTestWs();
    const first = sessionRegistry.registerExtensionSession(extensionWs.ws, "first-unknown-code");
    const second = sessionRegistry.registerExtensionSession(extensionWs.ws, "second-unknown-code");

    assert.equal(sessionRegistry.getExtensionSession(extensionWs.ws), second);
    assert.equal(sessionRegistry.getAllExtensionSessions().length, 1);
    assert.notEqual(second.id, first.id);
    assert.equal(second.pendingJoinCode, "second-unknown-code");
  });
});

describe("session registry pending extension binding", () => {
  beforeEach(() => {
    sessionRegistry.clearAllSessions();
  });

  it("binds a pending join code when the app reclaims its session", () => {
    const appWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);
    sessionRegistry.removeAppSession(appWs.ws);

    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, app.joinCode);
    assert.equal(extension.pendingJoinCode, app.joinCode);
    assert.equal(extension.appSessionId, undefined);

    const reclaimWs = createTestWs();
    sessionRegistry.reclaimAppSession(app.id, reclaimWs.ws);

    assert.equal(extension.appSessionId, app.id);
    assert.equal(extension.bindingId, app.bindingId);
    assert.equal(extension.pendingJoinCode, undefined);
  });

  it("binds a pending binding id when a new app registers with the same token", () => {
    const firstAppWs = createTestWs();
    const firstApp = sessionRegistry.registerAppSession(firstAppWs.ws);
    const token = bindingTokenModule.createBindingToken(firstApp.bindingId);
    sessionRegistry.discardAppSession(firstAppWs.ws);

    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, undefined, token);

    const secondAppWs = createTestWs();
    const secondApp = sessionRegistry.registerAppSession(secondAppWs.ws, token);

    assert.equal(extension.appSessionId, secondApp.id);
    assert.equal(extension.bindingId, firstApp.bindingId);
    assert.equal(extension.pendingBindingId, undefined);
    assert.deepEqual(lastStatus(extensionWs), {
      type: "session:appStatus",
      payload: { bound: true, bindingToken: token, clientConnected: true },
    });
  });

  it("binds a disconnected pending extension without sending it an appStatus", () => {
    const firstAppWs = createTestWs();
    const firstApp = sessionRegistry.registerAppSession(firstAppWs.ws);
    const token = bindingTokenModule.createBindingToken(firstApp.bindingId);
    sessionRegistry.discardAppSession(firstAppWs.ws);

    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, undefined, token);
    sessionRegistry.removeExtensionSession(extensionWs.ws);

    const secondAppWs = createTestWs();
    const secondApp = sessionRegistry.registerAppSession(secondAppWs.ws, token);

    const cached = sessionRegistry.getDisconnectedExtensionSessions();
    assert.equal(cached.length, 1);
    assert.equal(cached[0].session.id, extension.id);
    assert.equal(cached[0].session.appSessionId, secondApp.id);
    assert.equal(cached[0].session.bindingId, firstApp.bindingId);
    assert.equal(cached[0].session.pendingBindingId, undefined);
    assert.deepEqual(extensionWs.messages, []);
  });

  it("re-notifies an already bound extension for every further extension that binds", () => {
    const firstAppWs = createTestWs();
    const firstApp = sessionRegistry.registerAppSession(firstAppWs.ws);
    const token = bindingTokenModule.createBindingToken(firstApp.bindingId);
    sessionRegistry.discardAppSession(firstAppWs.ws);

    const firstExtensionWs = createTestWs();
    sessionRegistry.registerExtensionSession(firstExtensionWs.ws, undefined, token);
    const secondExtensionWs = createTestWs();
    sessionRegistry.registerExtensionSession(secondExtensionWs.ws, undefined, token);

    const secondAppWs = createTestWs();
    sessionRegistry.registerAppSession(secondAppWs.ws, token);

    const bound = { type: "session:appStatus", payload: { bound: true, bindingToken: token, clientConnected: true } };
    assert.deepEqual(statuses(firstExtensionWs), [bound, bound]);
    assert.deepEqual(statuses(secondExtensionWs), [bound]);
  });
});

describe("session registry app disconnect and reclaim", () => {
  beforeEach(() => {
    sessionRegistry.clearAllSessions();
  });

  it("caches the app session and reports the client as disconnected on remove", () => {
    const appWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);
    const token = bindingTokenModule.createBindingToken(app.bindingId);
    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, app.joinCode);

    const removed = sessionRegistry.removeAppSession(appWs.ws);

    assert.equal(removed, app);
    assert.deepEqual(sessionRegistry.getSessionCount(), { apps: 0, extensions: 1 });
    const cached = sessionRegistry.getDisconnectedAppSessions();
    assert.equal(cached.length, 1);
    assert.equal(cached[0].session.id, app.id);
    assert.equal(extension.appSessionId, app.id);
    assert.equal(extension.bindingId, app.bindingId);
    assert.deepEqual(statuses(extensionWs), [
      { type: "session:appStatus", payload: { bound: true, bindingToken: token, clientConnected: false } },
    ]);
  });

  it("drops the app session and unbinds extensions on discard", () => {
    const appWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);
    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, app.joinCode);

    const discarded = sessionRegistry.discardAppSession(appWs.ws);

    assert.equal(discarded, app);
    assert.deepEqual(sessionRegistry.getSessionCount(), { apps: 0, extensions: 1 });
    assert.deepEqual(sessionRegistry.getDisconnectedAppSessions(), []);
    assert.equal(sessionRegistry.reclaimAppSession(app.id, createTestWs().ws), undefined);
    assert.equal(extension.appSessionId, undefined);
    assert.equal(extension.bindingId, app.bindingId);
    assert.equal(extension.pendingBindingId, app.bindingId);
    assert.deepEqual(statuses(extensionWs), [{ type: "session:appStatus", payload: { bound: false } }]);
  });

  it("restores the session on the new socket and re-notifies bound extensions twice on reclaim", () => {
    const appWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);
    const token = bindingTokenModule.createBindingToken(app.bindingId);
    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, app.joinCode);
    sessionRegistry.removeAppSession(appWs.ws);

    const reclaimWs = createTestWs();
    const reclaimed = sessionRegistry.reclaimAppSession(app.id, reclaimWs.ws);

    assert.equal(reclaimed, app);
    assert.equal(sessionRegistry.getAppSession(reclaimWs.ws), app);
    assert.equal(sessionRegistry.getAppSession(appWs.ws), undefined);
    assert.equal(reclaimed?.joinCode, app.joinCode);
    assert.deepEqual(sessionRegistry.getDisconnectedAppSessions(), []);
    assert.equal(extension.appSessionId, app.id);

    const connected = {
      type: "session:appStatus",
      payload: { bound: true, bindingToken: token, clientConnected: true },
    };
    assert.deepEqual(statuses(extensionWs), [
      { type: "session:appStatus", payload: { bound: true, bindingToken: token, clientConnected: false } },
      connected,
      connected,
    ]);
  });

  it("returns undefined when reclaiming an unknown app session id", () => {
    assert.equal(sessionRegistry.reclaimAppSession("app_missing", createTestWs().ws), undefined);
  });

  it("moves an extension off a disconnected app onto a new app with the same binding id", () => {
    const firstAppWs = createTestWs();
    const firstApp = sessionRegistry.registerAppSession(firstAppWs.ws);
    const token = bindingTokenModule.createBindingToken(firstApp.bindingId);
    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, firstApp.joinCode);

    sessionRegistry.removeAppSession(firstAppWs.ws);
    assert.equal(extension.appSessionId, firstApp.id);

    const secondAppWs = createTestWs();
    const secondApp = sessionRegistry.registerAppSession(secondAppWs.ws, token);

    assert.notEqual(secondApp.id, firstApp.id);
    assert.equal(secondApp.bindingId, firstApp.bindingId);
    assert.equal(extension.appSessionId, secondApp.id);
    assert.equal(extension.bindingId, secondApp.bindingId);
    assert.equal(extension.pendingBindingId, undefined);
    assert.deepEqual(lastStatus(extensionWs), {
      type: "session:appStatus",
      payload: { bound: true, bindingToken: token, clientConnected: true },
    });
  });
});

describe("session registry extension disconnect and reclaim", () => {
  beforeEach(() => {
    sessionRegistry.clearAllSessions();
  });

  it("rebinds a reclaimed extension to the live app carrying its binding id", () => {
    const appWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);
    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, app.joinCode);
    sessionRegistry.removeExtensionSession(extensionWs.ws);

    const reclaimWs = createTestWs();
    const reclaimed = sessionRegistry.reclaimExtensionSession(extension.id, reclaimWs.ws);

    assert.equal(reclaimed, extension);
    assert.equal(reclaimed?.appSessionId, app.id);
    assert.equal(sessionRegistry.getExtensionSession(reclaimWs.ws), extension);
    assert.deepEqual(sessionRegistry.getDisconnectedExtensionSessions(), []);
  });

  it("keeps the stale app session id when no live app carries the reclaimed binding id", () => {
    const appWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);
    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, app.joinCode);
    sessionRegistry.removeExtensionSession(extensionWs.ws);
    sessionRegistry.removeAppSession(appWs.ws);

    const reclaimWs = createTestWs();
    const reclaimed = sessionRegistry.reclaimExtensionSession(extension.id, reclaimWs.ws);

    assert.equal(reclaimed?.appSessionId, app.id);
    assert.equal(sessionRegistry.getAppSessionById(app.id), undefined);
    assert.equal(reclaimed?.bindingId, app.bindingId);
  });

  it("drops the extension without caching it on discard", () => {
    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, "unknown-join-code");

    const discarded = sessionRegistry.discardExtensionSession(extensionWs.ws);

    assert.equal(discarded, extension);
    assert.deepEqual(sessionRegistry.getDisconnectedExtensionSessions(), []);
    assert.equal(sessionRegistry.reclaimExtensionSession(extension.id, createTestWs().ws), undefined);
  });

  it("returns undefined when reclaiming an unknown extension session id", () => {
    assert.equal(sessionRegistry.reclaimExtensionSession("ext_missing", createTestWs().ws), undefined);
  });
});

describe("session registry kill and shutdown", () => {
  beforeEach(() => {
    sessionRegistry.clearAllSessions();
  });

  it("kills a live app session, closes its socket and unbinds its extensions", () => {
    const appWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);
    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, app.joinCode);

    assert.equal(sessionRegistry.killSessionById(app.id), true);

    assert.deepEqual(sessionRegistry.getSessionCount(), { apps: 0, extensions: 1 });
    assert.deepEqual(sessionRegistry.getDisconnectedAppSessions(), []);
    assert.equal(appWs.closes.length, 1);
    assert.equal(appWs.closes[0].code, 1000);
    assert.equal(extension.appSessionId, undefined);
    assert.equal(extension.bindingId, app.bindingId);
    assert.equal(extension.pendingBindingId, app.bindingId);
    assert.deepEqual(statuses(extensionWs), [{ type: "session:appStatus", payload: { bound: false } }]);
  });

  it("kills a disconnected app session and unbinds its extensions", () => {
    const appWs = createTestWs();
    const app = sessionRegistry.registerAppSession(appWs.ws);
    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, app.joinCode);
    sessionRegistry.removeAppSession(appWs.ws);

    assert.equal(sessionRegistry.killSessionById(app.id), true);

    assert.deepEqual(sessionRegistry.getDisconnectedAppSessions(), []);
    assert.equal(extension.appSessionId, undefined);
    assert.equal(extension.pendingBindingId, app.bindingId);
  });

  it("kills a live extension session and closes its socket", () => {
    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, "unknown-join-code");

    assert.equal(sessionRegistry.killSessionById(extension.id), true);

    assert.deepEqual(sessionRegistry.getSessionCount(), { apps: 0, extensions: 0 });
    assert.equal(extensionWs.closes.length, 1);
    assert.equal(extensionWs.closes[0].code, 1000);
  });

  it("kills a disconnected extension session", () => {
    const extensionWs = createTestWs();
    const extension = sessionRegistry.registerExtensionSession(extensionWs.ws, "unknown-join-code");
    sessionRegistry.removeExtensionSession(extensionWs.ws);

    assert.equal(sessionRegistry.killSessionById(extension.id), true);

    assert.deepEqual(sessionRegistry.getDisconnectedExtensionSessions(), []);
  });

  it("returns false when killing an unknown session id", () => {
    assert.equal(sessionRegistry.killSessionById("app_missing"), false);
  });

  it("closes live sockets and clears every cache on closeAllSessions", () => {
    const liveAppWs = createTestWs();
    const liveApp = sessionRegistry.registerAppSession(liveAppWs.ws);
    const liveExtensionWs = createTestWs();
    sessionRegistry.registerExtensionSession(liveExtensionWs.ws, liveApp.joinCode);
    const goneAppWs = createTestWs();
    sessionRegistry.registerAppSession(goneAppWs.ws);
    sessionRegistry.removeAppSession(goneAppWs.ws);
    const goneExtensionWs = createTestWs();
    sessionRegistry.registerExtensionSession(goneExtensionWs.ws, "unknown-join-code");
    sessionRegistry.removeExtensionSession(goneExtensionWs.ws);

    sessionRegistry.closeAllSessions();

    assert.deepEqual(sessionRegistry.getSessionCount(), { apps: 0, extensions: 0 });
    assert.deepEqual(sessionRegistry.getDisconnectedAppSessions(), []);
    assert.deepEqual(sessionRegistry.getDisconnectedExtensionSessions(), []);
    assert.deepEqual(liveAppWs.closes, [{ code: 1001, reason: "server shutting down" }]);
    assert.deepEqual(liveExtensionWs.closes, [{ code: 1001, reason: "server shutting down" }]);
    assert.deepEqual(goneAppWs.closes, []);
    assert.deepEqual(goneExtensionWs.closes, []);
  });
});

describe("session registry disconnected cache purge", () => {
  beforeEach(() => {
    sessionRegistry.clearAllSessions();
  });

  it("purges the oldest disconnected app sessions down to the target once the cap is exceeded", () => {
    const ids: string[] = [];
    for (let i = 0; i <= DISCONNECTED_MAX_SIZE; i++) {
      const appWs = createTestWs();
      ids.push(sessionRegistry.registerAppSession(appWs.ws).id);
      sessionRegistry.removeAppSession(appWs.ws);
    }

    const remaining = new Set(sessionRegistry.getDisconnectedAppSessions().map((entry) => entry.session.id));
    assert.equal(remaining.size, DISCONNECTED_PURGE_TARGET);
    assert.equal(remaining.has(ids[0]), false);
    assert.equal(remaining.has(ids[ids.length - 1]), true);
  });

  it("purges the oldest disconnected extension sessions down to the target once the cap is exceeded", () => {
    const ids: string[] = [];
    for (let i = 0; i <= DISCONNECTED_MAX_SIZE; i++) {
      const extensionWs = createTestWs();
      ids.push(sessionRegistry.registerExtensionSession(extensionWs.ws).id);
      sessionRegistry.removeExtensionSession(extensionWs.ws);
    }

    const remaining = new Set(sessionRegistry.getDisconnectedExtensionSessions().map((entry) => entry.session.id));
    assert.equal(remaining.size, DISCONNECTED_PURGE_TARGET);
    assert.equal(remaining.has(ids[0]), false);
    assert.equal(remaining.has(ids[ids.length - 1]), true);
  });
});
