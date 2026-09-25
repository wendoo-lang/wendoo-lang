import { randomUUID } from "node:crypto";
import type { AppSessionJoinCodeMessage, ExtensionAppStatusMessage, SessionRole } from "@wendoo/bridge-protocol";
import { generateTriplet } from "@wendoo/join-codes";
import type { WSContext } from "hono/ws";
import { createBindingToken, generateBindingId, verifyBindingToken } from "#core/binding-token.js";
import { logger } from "#core/logging/logger.js";
import { safeSend } from "#transport/ws/safe-send.js";

const JOIN_CODE_TTL_MS = 10 * 60 * 1000;
const DISCONNECTED_SESSION_TTL_MS = 5 * 60 * 1000;
const DISCONNECTED_SWEEP_INTERVAL_MS = 60 * 1000;
const DISCONNECTED_MAX_SIZE = 10_000;
const DISCONNECTED_PURGE_TARGET = 8_000;

interface BaseSession {
  id: string;
  role: SessionRole;
  ws: WSContext;
  connectedAt: number;
}

export interface AppSession extends BaseSession {
  role: "app";
  joinCode: string;
  bindingId: string;
}

export interface ExtensionSession extends BaseSession {
  role: "extension";
  appSessionId: string | undefined;
  bindingId: string | undefined;
  pendingJoinCode: string | undefined;
  pendingBindingId: string | undefined;
}

// Active sessions are keyed by WebSocket; disconnected sessions are cached by ID
// with a TTL. The cache allows seamless reconnection: when an app or extension
// reconnects within the TTL window, it rebinds to its previous session state
// instead of starting fresh.
const appSessions = new Map<WSContext, AppSession>();
const extensionSessions = new Map<WSContext, ExtensionSession>();
const activeJoinCodes = new Set<string>();
const disconnectedAppSessions = new Map<string, { session: AppSession; disconnectedAt: number }>();
const disconnectedExtensionSessions = new Map<string, { session: ExtensionSession; disconnectedAt: number }>();
let joinCodeTimer: ReturnType<typeof setInterval> | undefined;
let disconnectedSweepTimer: ReturnType<typeof setInterval> | undefined;

// Collision-resistant code generation: try up to 100 random triplets.
// If all collide (extremely unlikely with a small active set), fall back
// to a triplet + UUID suffix that is virtually guaranteed unique.
function generateUniqueJoinCode(): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = generateTriplet();
    if (!activeJoinCodes.has(code)) {
      return code;
    }
  }
  return `${generateTriplet()}-${randomUUID().slice(0, 8)}`;
}

function refreshAllJoinCodes(): void {
  for (const session of appSessions.values()) {
    activeJoinCodes.delete(session.joinCode);
    const newCode = generateUniqueJoinCode();
    session.joinCode = newCode;
    activeJoinCodes.add(newCode);
    const msg: AppSessionJoinCodeMessage = {
      type: "session:joinCode",
      payload: { joinCode: newCode },
    };
    safeSend(session.ws, JSON.stringify(msg));
  }
  logger.info({ count: appSessions.size }, "refreshed all join codes");
}

function ensureJoinCodeTimer(): void {
  if (joinCodeTimer) return;
  joinCodeTimer = setInterval(refreshAllJoinCodes, JOIN_CODE_TTL_MS);
  joinCodeTimer.unref();
}

function stopJoinCodeTimer(): void {
  if (joinCodeTimer) {
    clearInterval(joinCodeTimer);
    joinCodeTimer = undefined;
  }
}

function notifyExtensionsAppStatus(appSessionId: string, bound: boolean, clientConnected?: boolean): void {
  const extensions = getExtensionsByAppSessionId(appSessionId);
  if (extensions.length === 0) {
    logger.info({ appSessionId, bound }, "no extensions to notify of appStatus");
    return;
  }
  const payload: ExtensionAppStatusMessage["payload"] = { bound };
  if (bound) {
    const app = getAppSessionById(appSessionId);
    if (!app) {
      const disconnected = disconnectedAppSessions.get(appSessionId);
      if (disconnected) {
        payload.bindingToken = createBindingToken(disconnected.session.bindingId);
      }
    } else {
      payload.bindingToken = createBindingToken(app.bindingId);
    }
    if (clientConnected !== undefined) {
      payload.clientConnected = clientConnected;
    }
  }
  const msg: ExtensionAppStatusMessage = {
    type: "session:appStatus",
    payload,
  };
  const serialized = JSON.stringify(msg);
  for (const ext of extensions) {
    logger.info({ extensionSessionId: ext.id, appSessionId, bound, clientConnected }, "sending appStatus to extension");
    safeSend(ext.ws, serialized);
  }
}

function unbindExtensionsFromApp(appSessionId: string, pendingBindingId?: string): void {
  notifyExtensionsAppStatus(appSessionId, false);
  for (const session of extensionSessions.values()) {
    if (session.appSessionId === appSessionId) {
      session.appSessionId = undefined;
      if (pendingBindingId) {
        session.bindingId = pendingBindingId;
        session.pendingBindingId = pendingBindingId;
      }
      logger.info({ extensionSessionId: session.id, appSessionId }, "unbound active extension from purged app session");
    }
  }
  for (const entry of disconnectedExtensionSessions.values()) {
    if (entry.session.appSessionId === appSessionId) {
      entry.session.appSessionId = undefined;
      if (pendingBindingId) {
        entry.session.bindingId = pendingBindingId;
        entry.session.pendingBindingId = pendingBindingId;
      }
      logger.info(
        { extensionSessionId: entry.session.id, appSessionId },
        "unbound disconnected extension from purged app session"
      );
    }
  }
}

function sweepDisconnectedSessions(): void {
  const now = Date.now();
  for (const [id, entry] of disconnectedAppSessions) {
    if (now - entry.disconnectedAt >= DISCONNECTED_SESSION_TTL_MS) {
      activeJoinCodes.delete(entry.session.joinCode);
      disconnectedAppSessions.delete(id);
      unbindExtensionsFromApp(id, entry.session.bindingId);
      logger.info({ sessionId: id }, "expired disconnected app session");
    }
  }
  for (const [id, entry] of disconnectedExtensionSessions) {
    if (now - entry.disconnectedAt >= DISCONNECTED_SESSION_TTL_MS) {
      disconnectedExtensionSessions.delete(id);
      logger.info({ sessionId: id }, "expired disconnected extension session");
    }
  }
  if (disconnectedAppSessions.size === 0 && disconnectedExtensionSessions.size === 0) stopDisconnectedSweepTimer();
}

function purgeDisconnectedIfNeeded(kind: "app" | "extension"): void {
  if (kind === "app") {
    if (disconnectedAppSessions.size <= DISCONNECTED_MAX_SIZE) return;
    const entries = [...disconnectedAppSessions.entries()].sort((a, b) => a[1].disconnectedAt - b[1].disconnectedAt);
    const toRemove = entries.length - DISCONNECTED_PURGE_TARGET;
    for (let i = 0; i < toRemove; i++) {
      const [id, entry] = entries[i];
      activeJoinCodes.delete(entry.session.joinCode);
      disconnectedAppSessions.delete(id);
      unbindExtensionsFromApp(id, entry.session.bindingId);
    }
    logger.info({ purged: toRemove, remaining: disconnectedAppSessions.size }, "purged disconnected app sessions");
  } else {
    if (disconnectedExtensionSessions.size <= DISCONNECTED_MAX_SIZE) return;
    const entries = [...disconnectedExtensionSessions.entries()].sort(
      (a, b) => a[1].disconnectedAt - b[1].disconnectedAt
    );
    const toRemove = entries.length - DISCONNECTED_PURGE_TARGET;
    for (let i = 0; i < toRemove; i++) {
      const [id] = entries[i];
      disconnectedExtensionSessions.delete(id);
    }
    logger.info(
      { purged: toRemove, remaining: disconnectedExtensionSessions.size },
      "purged disconnected extension sessions"
    );
  }
}

function ensureDisconnectedSweepTimer(): void {
  if (disconnectedSweepTimer) return;
  disconnectedSweepTimer = setInterval(sweepDisconnectedSessions, DISCONNECTED_SWEEP_INTERVAL_MS);
  disconnectedSweepTimer.unref();
}

function stopDisconnectedSweepTimer(): void {
  if (disconnectedSweepTimer) {
    clearInterval(disconnectedSweepTimer);
    disconnectedSweepTimer = undefined;
  }
}

export function registerAppSession(ws: WSContext, bindingToken?: string): AppSession {
  const existing = appSessions.get(ws);
  if (existing) {
    logger.warn({ sessionId: existing.id }, "app session already registered, replacing");
    activeJoinCodes.delete(existing.joinCode);
    appSessions.delete(ws);
  }

  let bindingId: string;
  if (bindingToken) {
    const verified = verifyBindingToken(bindingToken);
    if (verified) {
      bindingId = verified;
      logger.info({ bindingId }, "app restored bindingId from token");
    } else {
      bindingId = generateBindingId();
      logger.warn("app sent invalid bindingToken; generated new bindingId");
    }
  } else {
    bindingId = generateBindingId();
  }

  const joinCode = generateUniqueJoinCode();
  const session: AppSession = {
    id: `app_${randomUUID()}`,
    role: "app",
    ws,
    connectedAt: Date.now(),
    joinCode,
    bindingId,
  };

  appSessions.set(ws, session);
  activeJoinCodes.add(joinCode);
  ensureJoinCodeTimer();
  logger.info({ sessionId: session.id, joinCode }, "app session registered");
  bindPendingExtensions(session);
  return session;
}

function bindPendingExtensions(app: AppSession): void {
  for (const ext of extensionSessions.values()) {
    const matchJoinCode = ext.pendingJoinCode && ext.pendingJoinCode === app.joinCode;
    const matchBinding = ext.bindingId === app.bindingId || ext.pendingBindingId === app.bindingId;
    if (matchJoinCode || matchBinding) {
      ext.appSessionId = app.id;
      ext.bindingId = app.bindingId;
      ext.pendingJoinCode = undefined;
      ext.pendingBindingId = undefined;
      logger.info(
        {
          extensionSessionId: ext.id,
          appSessionId: app.id,
          matchJoinCode: !!matchJoinCode,
          matchBinding: !!matchBinding,
        },
        "bound pending extension to app"
      );
      notifyExtensionsAppStatus(app.id, true, true);
    }
  }
  for (const entry of disconnectedExtensionSessions.values()) {
    const matchJoinCode = entry.session.pendingJoinCode && entry.session.pendingJoinCode === app.joinCode;
    const matchBinding = entry.session.bindingId === app.bindingId || entry.session.pendingBindingId === app.bindingId;
    if (matchJoinCode || matchBinding) {
      entry.session.appSessionId = app.id;
      entry.session.bindingId = app.bindingId;
      entry.session.pendingJoinCode = undefined;
      entry.session.pendingBindingId = undefined;
      logger.info(
        { extensionSessionId: entry.session.id, appSessionId: app.id },
        "bound pending disconnected extension to app"
      );
    }
  }

  rebindExtensionsFromDisconnectedApp(app);
}

function rebindExtensionsFromDisconnectedApp(app: AppSession): void {
  for (const ext of extensionSessions.values()) {
    if (ext.bindingId === app.bindingId && ext.appSessionId !== app.id) {
      ext.appSessionId = app.id;
      ext.pendingJoinCode = undefined;
      ext.pendingBindingId = undefined;
      logger.info(
        { extensionSessionId: ext.id, newAppSessionId: app.id },
        "rebound extension to new app with same bindingId"
      );
      notifyExtensionsAppStatus(app.id, true, true);
    } else if (ext.appSessionId && ext.appSessionId !== app.id) {
      const oldApp = disconnectedAppSessions.get(ext.appSessionId);
      if (oldApp && oldApp.session.bindingId === app.bindingId) {
        logger.info(
          { extensionSessionId: ext.id, oldAppSessionId: ext.appSessionId, newAppSessionId: app.id },
          "rebound extension from disconnected app to new app with same bindingId"
        );
        ext.appSessionId = app.id;
        ext.bindingId = app.bindingId;
        ext.pendingJoinCode = undefined;
        ext.pendingBindingId = undefined;
        notifyExtensionsAppStatus(app.id, true, true);
      }
    }
  }
  for (const entry of disconnectedExtensionSessions.values()) {
    if (entry.session.bindingId === app.bindingId && entry.session.appSessionId !== app.id) {
      entry.session.appSessionId = app.id;
      entry.session.pendingJoinCode = undefined;
      entry.session.pendingBindingId = undefined;
      logger.info(
        { extensionSessionId: entry.session.id, newAppSessionId: app.id },
        "rebound disconnected extension to new app with same bindingId"
      );
    } else if (entry.session.appSessionId && entry.session.appSessionId !== app.id) {
      const oldApp = disconnectedAppSessions.get(entry.session.appSessionId);
      if (oldApp && oldApp.session.bindingId === app.bindingId) {
        logger.info(
          {
            extensionSessionId: entry.session.id,
            oldAppSessionId: entry.session.appSessionId,
            newAppSessionId: app.id,
          },
          "rebound disconnected extension from disconnected app to new app with same bindingId"
        );
        entry.session.appSessionId = app.id;
        entry.session.bindingId = app.bindingId;
        entry.session.pendingJoinCode = undefined;
        entry.session.pendingBindingId = undefined;
      }
    }
  }
}

export function registerExtensionSession(ws: WSContext, joinCode?: string, bindingToken?: string): ExtensionSession {
  const existing = extensionSessions.get(ws);
  if (existing) {
    logger.warn({ sessionId: existing.id }, "extension session already registered, replacing");
    extensionSessions.delete(ws);
  }

  let appSessionId: string | undefined;
  let bindingId: string | undefined;
  let pendingJoinCode: string | undefined;
  let pendingBindingId: string | undefined;

  if (joinCode) {
    const app = getAppByJoinCode(joinCode);
    if (app) {
      appSessionId = app.id;
      bindingId = app.bindingId;
    } else {
      pendingJoinCode = joinCode;
    }
  }

  if (!appSessionId && bindingToken) {
    const verified = verifyBindingToken(bindingToken);
    if (verified) {
      bindingId = verified;
      const app = getAppByBindingId(verified);
      if (app) {
        appSessionId = app.id;
        pendingJoinCode = undefined;
        logger.info({ bindingId: verified }, "extension bound via bindingToken");
      } else {
        pendingBindingId = verified;
        logger.info({ bindingId: verified }, "extension pending with verified bindingId");
      }
    } else {
      logger.warn("extension sent invalid bindingToken");
    }
  }

  if (!appSessionId && pendingJoinCode) {
    logger.warn({ joinCode }, "extension hello with unknown joinCode (pending)");
  }

  const session: ExtensionSession = {
    id: `ext_${randomUUID()}`,
    role: "extension",
    ws,
    connectedAt: Date.now(),
    appSessionId,
    bindingId,
    pendingJoinCode,
    pendingBindingId,
  };

  extensionSessions.set(ws, session);
  logger.info({ sessionId: session.id, appSessionId, pendingBindingId }, "extension session registered");
  return session;
}

export function removeAppSession(ws: WSContext): AppSession | undefined {
  const session = appSessions.get(ws);
  if (session) {
    appSessions.delete(ws);
    disconnectedAppSessions.set(session.id, { session, disconnectedAt: Date.now() });
    purgeDisconnectedIfNeeded("app");
    ensureDisconnectedSweepTimer();
    notifyExtensionsAppStatus(session.id, true, false);
    if (appSessions.size === 0) {
      stopJoinCodeTimer();
    }
    logger.info({ sessionId: session.id }, "app session disconnected (available for reclaim)");
  }
  return session;
}

export function discardAppSession(ws: WSContext): AppSession | undefined {
  const session = appSessions.get(ws);
  if (session) {
    appSessions.delete(ws);
    activeJoinCodes.delete(session.joinCode);
    unbindExtensionsFromApp(session.id, session.bindingId);
    if (appSessions.size === 0) {
      stopJoinCodeTimer();
    }
    logger.info({ sessionId: session.id }, "app session discarded (goodbye)");
  }
  return session;
}

export function reclaimAppSession(sessionId: string, ws: WSContext): AppSession | undefined {
  const entry = disconnectedAppSessions.get(sessionId);
  if (!entry) return undefined;
  disconnectedAppSessions.delete(sessionId);
  if (disconnectedAppSessions.size === 0 && disconnectedExtensionSessions.size === 0) stopDisconnectedSweepTimer();
  entry.session.ws = ws;
  entry.session.connectedAt = Date.now();
  appSessions.set(ws, entry.session);
  ensureJoinCodeTimer();

  notifyExtensionsAppStatus(entry.session.id, true, true);

  logger.info({ sessionId: entry.session.id, joinCode: entry.session.joinCode }, "app session reclaimed");
  bindPendingExtensions(entry.session);
  return entry.session;
}

export function removeExtensionSession(ws: WSContext): ExtensionSession | undefined {
  const session = extensionSessions.get(ws);
  if (session) {
    extensionSessions.delete(ws);
    disconnectedExtensionSessions.set(session.id, { session, disconnectedAt: Date.now() });
    purgeDisconnectedIfNeeded("extension");
    ensureDisconnectedSweepTimer();
    logger.info({ sessionId: session.id }, "extension session disconnected (available for reclaim)");
  }
  return session;
}

export function discardExtensionSession(ws: WSContext): ExtensionSession | undefined {
  const session = extensionSessions.get(ws);
  if (session) {
    extensionSessions.delete(ws);
    logger.info({ sessionId: session.id }, "extension session discarded (goodbye)");
  }
  return session;
}

export function reclaimExtensionSession(sessionId: string, ws: WSContext): ExtensionSession | undefined {
  const entry = disconnectedExtensionSessions.get(sessionId);
  if (!entry) return undefined;
  disconnectedExtensionSessions.delete(sessionId);
  if (disconnectedAppSessions.size === 0 && disconnectedExtensionSessions.size === 0) stopDisconnectedSweepTimer();
  entry.session.ws = ws;
  entry.session.connectedAt = Date.now();
  if (entry.session.bindingId) {
    const app = getAppByBindingId(entry.session.bindingId);
    if (app) {
      entry.session.appSessionId = app.id;
      entry.session.pendingJoinCode = undefined;
      entry.session.pendingBindingId = undefined;
    }
  }
  extensionSessions.set(ws, entry.session);
  logger.info({ sessionId: entry.session.id }, "extension session reclaimed");
  return entry.session;
}

export function getAppSession(ws: WSContext): AppSession | undefined {
  return appSessions.get(ws);
}

export function getAppSessionById(sessionId: string): AppSession | undefined {
  for (const session of appSessions.values()) {
    if (session.id === sessionId) {
      return session;
    }
  }
  return undefined;
}

export function getExtensionSession(ws: WSContext): ExtensionSession | undefined {
  return extensionSessions.get(ws);
}

export function getSessionCount(): { apps: number; extensions: number } {
  return {
    apps: appSessions.size,
    extensions: extensionSessions.size,
  };
}

export function getAllAppSessions(): AppSession[] {
  return [...appSessions.values()];
}

export function getAllExtensionSessions(): ExtensionSession[] {
  return [...extensionSessions.values()];
}

export function getDisconnectedAppSessions(): { session: AppSession; disconnectedAt: number }[] {
  return [...disconnectedAppSessions.values()];
}

export function getDisconnectedExtensionSessions(): { session: ExtensionSession; disconnectedAt: number }[] {
  return [...disconnectedExtensionSessions.values()];
}

export function getExtensionsByAppSessionId(appSessionId: string): ExtensionSession[] {
  const result: ExtensionSession[] = [];
  for (const session of extensionSessions.values()) {
    if (session.appSessionId === appSessionId) {
      result.push(session);
    }
  }
  return result;
}

export function getAppByJoinCode(joinCode: string): AppSession | undefined {
  for (const session of appSessions.values()) {
    if (session.joinCode === joinCode) {
      return session;
    }
  }
  return undefined;
}

export function getAppByBindingId(bindingId: string): AppSession | undefined {
  for (const session of appSessions.values()) {
    if (session.bindingId === bindingId) {
      return session;
    }
  }
  return undefined;
}

export function disconnectSessionById(sessionId: string): boolean {
  for (const session of appSessions.values()) {
    if (session.id === sessionId) {
      session.ws.close(1000, "closed via repl");
      return true;
    }
  }
  for (const session of extensionSessions.values()) {
    if (session.id === sessionId) {
      session.ws.close(1000, "closed via repl");
      return true;
    }
  }
  return false;
}

export function killSessionById(sessionId: string): boolean {
  for (const [ws, session] of appSessions) {
    if (session.id === sessionId) {
      appSessions.delete(ws);
      activeJoinCodes.delete(session.joinCode);
      unbindExtensionsFromApp(session.id, session.bindingId);
      if (appSessions.size === 0) stopJoinCodeTimer();
      try {
        session.ws.close(1000, "killed via repl");
      } catch {}
      logger.info({ sessionId }, "app session killed via repl");
      return true;
    }
  }
  for (const [ws, session] of extensionSessions) {
    if (session.id === sessionId) {
      extensionSessions.delete(ws);
      try {
        session.ws.close(1000, "killed via repl");
      } catch {}
      logger.info({ sessionId }, "extension session killed via repl");
      return true;
    }
  }
  if (disconnectedAppSessions.has(sessionId)) {
    const entry = disconnectedAppSessions.get(sessionId)!;
    activeJoinCodes.delete(entry.session.joinCode);
    disconnectedAppSessions.delete(sessionId);
    unbindExtensionsFromApp(sessionId, entry.session.bindingId);
    if (disconnectedAppSessions.size === 0 && disconnectedExtensionSessions.size === 0) stopDisconnectedSweepTimer();
    logger.info({ sessionId }, "disconnected app session killed via repl");
    return true;
  }
  if (disconnectedExtensionSessions.has(sessionId)) {
    disconnectedExtensionSessions.delete(sessionId);
    if (disconnectedAppSessions.size === 0 && disconnectedExtensionSessions.size === 0) stopDisconnectedSweepTimer();
    logger.info({ sessionId }, "disconnected extension session killed via repl");
    return true;
  }
  return false;
}

export function closeAllSessions(): void {
  stopJoinCodeTimer();
  stopDisconnectedSweepTimer();
  for (const session of appSessions.values()) {
    try {
      session.ws.close(1001, "server shutting down");
    } catch {}
  }
  for (const session of extensionSessions.values()) {
    try {
      session.ws.close(1001, "server shutting down");
    } catch {}
  }
  appSessions.clear();
  extensionSessions.clear();
  activeJoinCodes.clear();
  disconnectedAppSessions.clear();
  disconnectedExtensionSessions.clear();
}

export function clearAllSessions(): void {
  stopJoinCodeTimer();
  stopDisconnectedSweepTimer();
  appSessions.clear();
  extensionSessions.clear();
  activeJoinCodes.clear();
  disconnectedAppSessions.clear();
  disconnectedExtensionSessions.clear();
}
