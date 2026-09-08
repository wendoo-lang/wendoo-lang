import { name as simName } from "../../package.json";

const APP_SETTINGS_STORAGE_KEY = `${simName}:app-settings`;

/** The sim's global, user-editable settings, persisted in `localStorage`. */
export interface AppSettings {
  /** Address of the VS Code bridge as a host with an optional port; a scheme, if pasted, is ignored. */
  vscodeBridgeUrl: string;
  /** Address of the assistant service as a host with an optional port; a scheme, if pasted, is ignored. */
  assistantServiceUrl: string;
  /** Whether the sidebar offers the VS Code bridge panel. */
  showBridgePanel: boolean;
}

/** The settings a user who has never saved any gets. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  vscodeBridgeUrl: "vscode-bridge.playwendoo.com",
  assistantServiceUrl: "wendoo-assistant.playwendoo.com",
  showBridgePanel: true,
};

/** Default addresses shipped by earlier releases, replaced by the current defaults on load. */
const LEGACY_DEFAULT_ADDRESSES: Record<"vscodeBridgeUrl" | "assistantServiceUrl", readonly string[]> = {
  vscodeBridgeUrl: ["vscode-bridge.wendoo-lang.org", "vscode-bridge.mindcraft-lang.org"],
  assistantServiceUrl: ["wendoo-assistant.sklanch.net"],
};

/**
 * Reads the persisted settings, layered over {@link DEFAULT_APP_SETTINGS}, so a
 * stored blob missing a field gets that field's default. A stored address still
 * pointing at a retired default host is upgraded to the current default.
 * Returns the defaults when nothing is stored or the stored value is corrupt.
 */
export function loadAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      const settings = { ...DEFAULT_APP_SETTINGS, ...parsed };
      if (LEGACY_DEFAULT_ADDRESSES.vscodeBridgeUrl.includes(settings.vscodeBridgeUrl)) {
        settings.vscodeBridgeUrl = DEFAULT_APP_SETTINGS.vscodeBridgeUrl;
      }
      if (LEGACY_DEFAULT_ADDRESSES.assistantServiceUrl.includes(settings.assistantServiceUrl)) {
        settings.assistantServiceUrl = DEFAULT_APP_SETTINGS.assistantServiceUrl;
      }
      return settings;
    }
  } catch {
    // corrupted data -- fall through to defaults
  }
  return { ...DEFAULT_APP_SETTINGS };
}

/** Writes `settings` over the persisted blob, replacing it wholesale. */
export function persistAppSettings(settings: AppSettings): void {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

/** Returns `settings` with each address field that is empty or whitespace replaced by its default. */
export function normalizeAppSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    vscodeBridgeUrl: settings.vscodeBridgeUrl.trim() ? settings.vscodeBridgeUrl : DEFAULT_APP_SETTINGS.vscodeBridgeUrl,
    assistantServiceUrl: settings.assistantServiceUrl.trim()
      ? settings.assistantServiceUrl
      : DEFAULT_APP_SETTINGS.assistantServiceUrl,
  };
}
