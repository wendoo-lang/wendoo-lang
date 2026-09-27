import type { WendooEnvironment } from "@wendoo/core/app";
import { Vector2 } from "@wendoo/core/app";
import type { BrainEditorConfig, CustomLiteralType } from "@wendoo/ui";
import type { ReactNode } from "react";
import type { Archetype } from "@/brain/actor";
import { EcosimTypeIds } from "@/brain/type-system";
import type { EcosimEnvironmentStore } from "@/services/ecosim-environment-store";
import { dataTypeIconMap, dataTypeNameMap } from "./data-type-icons";
import { createVfsAwareVisualProvider } from "./visual-provider";

const inputClass =
  "col-span-3 flex h-10 w-full rounded-lg border-2 border-input bg-background px-3 py-2 text-sm pointer-coarse:min-h-11 pointer-coarse:text-base text-foreground placeholder:text-muted-foreground focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50";

const vector2LiteralType: CustomLiteralType = {
  typeId: EcosimTypeIds.Vector2,
  description: "Enter X and Y coordinates for the vector.",

  isValid(state: Record<string, string>): boolean {
    return (
      state.x !== "" &&
      state.y !== "" &&
      !Number.isNaN(Number.parseFloat(state.x ?? "")) &&
      !Number.isNaN(Number.parseFloat(state.y ?? ""))
    );
  },

  parseValue(state: Record<string, string>): unknown {
    const x = Number.parseFloat(state.x ?? "");
    const y = Number.parseFloat(state.y ?? "");
    if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
    return new Vector2(x, y);
  },

  toInputState(value: unknown): Record<string, string> {
    if (value && typeof value === "object" && "X" in value && "Y" in value) {
      const v = value as { X: number; Y: number };
      return { x: String(v.X), y: String(v.Y) };
    }
    return {};
  },

  renderInputFields(
    state: Record<string, string>,
    onChange: (key: string, value: string) => void,
    onSubmit: () => void
  ): ReactNode {
    const handleKeyDown = (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        onSubmit();
      }
    };

    return (
      <div className="grid gap-4">
        <div className="grid grid-cols-4 items-center gap-4">
          <label htmlFor="vector2X" className="text-right text-foreground font-medium">
            X
          </label>
          <input
            id="vector2X"
            type="number"
            value={state.x ?? ""}
            onChange={(e) => onChange("x", e.target.value)}
            onKeyDown={handleKeyDown}
            className={inputClass}
            placeholder="0"
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: dialog input should focus immediately for keyboard users
            autoFocus
          />
        </div>
        <div className="grid grid-cols-4 items-center gap-4">
          <label htmlFor="vector2Y" className="text-right text-foreground font-medium">
            Y
          </label>
          <input
            id="vector2Y"
            type="number"
            value={state.y ?? ""}
            onChange={(e) => onChange("y", e.target.value)}
            onKeyDown={handleKeyDown}
            className={inputClass}
            placeholder="0"
            autoComplete="off"
          />
        </div>
      </div>
    );
  },

  formatValue(value: unknown): string {
    if (value && typeof value === "object" && "X" in value && "Y" in value) {
      const v = value as { X: number; Y: number };
      return `(${v.X}, ${v.Y})`;
    }
    return String(value);
  },
};

interface BuildBrainEditorConfigOptions {
  store: EcosimEnvironmentStore;
  archetype?: Archetype;
  onTileDocs?: BrainEditorConfig["onTileDocs"];
  docsIntegration?: BrainEditorConfig["docsIntegration"];
  sidePanel?: BrainEditorConfig["sidePanel"];
  isBrokenTile?: BrainEditorConfig["isBrokenTile"];
}

export function buildBrainEditorConfig(options: BuildBrainEditorConfigOptions): BrainEditorConfig {
  const { store, archetype, onTileDocs, docsIntegration, sidePanel, isBrokenTile } = options;
  const environment = store.env;
  const resolveTileVisual = createVfsAwareVisualProvider((url) => store.resolveVfsAssetUrl(url));

  return {
    dataTypeIcons: dataTypeIconMap,
    dataTypeNames: dataTypeNameMap,
    resolveTileVisual,
    customLiteralTypes: [vector2LiteralType],
    getDefaultBrain: archetype ? () => store.getDefaultBrain(archetype) : undefined,
    brainServices: environment.brainServices,
    localizer: environment.appServices.localizer,
    projectNamespace: store.activeProjectManifest?.id,
    tileCatalogs: environment.tileCatalogs(),
    libraries: store.host.installedLibraries,
    printTransport: store.printTransport,
    onTileDocs,
    docsIntegration,
    sidePanel,
    isBrokenTile,
  };
}
