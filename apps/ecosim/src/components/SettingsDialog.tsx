import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
} from "@wendoo/ui";
import { useEffect, useState } from "react";
import { useEcosimEnvironment } from "@/contexts/ecosim-environment";
import { type AppSettings, DEFAULT_APP_SETTINGS } from "@/services/app-settings";
import { clearBindingToken, hasBindingToken } from "@/services/binding-token-persistence";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBridgeDisabled?: () => void;
}

export function SettingsDialog({ open, onOpenChange, onBridgeDisabled }: SettingsDialogProps) {
  const store = useEcosimEnvironment();
  const [draft, setDraft] = useState<AppSettings>(() => store.getAppSettings());
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(store.getAppSettings());
      setHasToken(hasBindingToken());
    }
  }, [open, store]);

  const save = () => {
    const wasShowingBridge = store.getAppSettings().showBridgePanel;
    store.updateAppSettings(draft);
    if (wasShowingBridge && !draft.showBridgePanel && store.getUiPreferences().bridgeEnabled) {
      store.updateUiPreferences({ bridgeEnabled: false });
      store.endBridge();
      clearBindingToken();
      onBridgeDisabled?.();
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-2xl">
        <DialogHeader className="border-b border-border pb-3">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure application settings</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between">
            <label htmlFor="show-bridge-panel" className="text-sm font-medium">
              Show VS Code Bridge Panel
            </label>
            <Switch
              id="show-bridge-panel"
              checked={draft.showBridgePanel}
              onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, showBridgePanel: checked }))}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="vscode-bridge-url" className="text-sm font-medium">
              VS Code Bridge URL
            </label>
            <Input
              id="vscode-bridge-url"
              value={draft.vscodeBridgeUrl}
              onChange={(e) => setDraft((prev) => ({ ...prev, vscodeBridgeUrl: e.target.value }))}
              placeholder={DEFAULT_APP_SETTINGS.vscodeBridgeUrl}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="assistant-service-url" className="text-sm font-medium">
              Assistant Service URL
            </label>
            <Input
              id="assistant-service-url"
              value={draft.assistantServiceUrl}
              onChange={(e) => setDraft((prev) => ({ ...prev, assistantServiceUrl: e.target.value }))}
              placeholder={DEFAULT_APP_SETTINGS.assistantServiceUrl}
            />
          </div>
        </div>
        <DialogFooter className="border-t border-border pt-3">
          <Button variant="cancel" className="rounded-lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="rounded-lg" onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
