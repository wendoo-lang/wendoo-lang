import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { assistantSessionUrl } from "@wendoo/assistant-panel";
import { name as simName } from "../../package.json";
import { DEFAULT_APP_SETTINGS, loadAppSettings, normalizeAppSettings, persistAppSettings } from "./app-settings";

const STORAGE_KEY = `${simName}:app-settings`;

/** Installs a `localStorage` backed by a live map and returns a restore function. */
function installLocalStorage(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length(): number {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  return () => {
    if (original) {
      Object.defineProperty(globalThis, "localStorage", original);
      return;
    }
    Reflect.deleteProperty(globalThis, "localStorage");
  };
}

describe("app settings", () => {
  let restoreLocalStorage: () => void;

  beforeEach(() => {
    restoreLocalStorage = installLocalStorage();
  });

  afterEach(() => {
    restoreLocalStorage();
  });

  it("loads the defaults when nothing is stored", () => {
    assert.deepEqual(loadAppSettings(), DEFAULT_APP_SETTINGS);
    assert.equal(DEFAULT_APP_SETTINGS.assistantServiceUrl, "wendoo-assistant.playwendoo.com");
  });

  it("gives a stored blob written without the assistant field its default", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ vscodeBridgeUrl: "bridge.example.net", showBridgePanel: false })
    );
    const loaded = loadAppSettings();
    assert.equal(loaded.assistantServiceUrl, DEFAULT_APP_SETTINGS.assistantServiceUrl);
    assert.equal(loaded.vscodeBridgeUrl, "bridge.example.net");
    assert.equal(loaded.showBridgePanel, false);
  });

  it("migrates stored legacy default addresses to the current defaults", () => {
    for (const legacyBridge of ["vscode-bridge.wendoo-lang.org", "vscode-bridge.mindcraft-lang.org"]) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ vscodeBridgeUrl: legacyBridge, assistantServiceUrl: "wendoo-assistant.sklanch.net" })
      );
      const loaded = loadAppSettings();
      assert.equal(loaded.vscodeBridgeUrl, DEFAULT_APP_SETTINGS.vscodeBridgeUrl, legacyBridge);
      assert.equal(loaded.assistantServiceUrl, DEFAULT_APP_SETTINGS.assistantServiceUrl, legacyBridge);
    }
  });

  it("round-trips a persisted assistant address", () => {
    persistAppSettings({ ...DEFAULT_APP_SETTINGS, assistantServiceUrl: "localhost:8787" });
    assert.equal(loadAppSettings().assistantServiceUrl, "localhost:8787");
  });

  it("falls back to the defaults for empty and whitespace addresses", () => {
    for (const blank of ["", "   "]) {
      const normalized = normalizeAppSettings({
        ...DEFAULT_APP_SETTINGS,
        assistantServiceUrl: blank,
        vscodeBridgeUrl: blank,
      });
      assert.equal(normalized.assistantServiceUrl, DEFAULT_APP_SETTINGS.assistantServiceUrl, blank);
      assert.equal(normalized.vscodeBridgeUrl, DEFAULT_APP_SETTINGS.vscodeBridgeUrl, blank);
    }
  });

  it("keeps a non-empty address as given", () => {
    const normalized = normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, assistantServiceUrl: "localhost:8787" });
    assert.equal(normalized.assistantServiceUrl, "localhost:8787");
  });

  it("derives a secure session address from the shipped assistant default", () => {
    assert.equal(
      assistantSessionUrl(DEFAULT_APP_SETTINGS.assistantServiceUrl),
      `wss://${DEFAULT_APP_SETTINGS.assistantServiceUrl}/api/assistant/session`
    );
  });
});
