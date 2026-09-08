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

/**
 * Reads the persisted settings, layered over {@link DEFAULT_APP_SETTINGS}, so a
 * stored blob missing a field gets that field's default. Returns the defaults
 * when nothing is stored or the stored value is corrupt.
 */
export function loadAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return { ...DEFAULT_APP_SETTINGS, ...parsed };
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
