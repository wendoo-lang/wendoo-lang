import { embeddedExtensionsVitePlugin } from "@wendoo/bridge-app/node";
import path from "path";

// The extensions apps/ecosim offers, by coordinate and source directory. The file
// list of each comes from its own wendoo.json, so adding a file to an
// extension needs no change here.
const registrations = [
  { coordinate: "wendoo-lang/trg-ecosim", dir: path.resolve(process.cwd(), "."), kind: "target" },
  { coordinate: "wendoo-lang/lib-ecosim", dir: path.resolve(process.cwd(), "./lib") },
  { coordinate: "wendoo-lang/lib-core", dir: path.resolve(process.cwd(), "../../packages/core/lib") },
  {
    coordinate: "wendoo-lang/lib-ecosim-teleport",
    dir: path.resolve(process.cwd(), "./extensions/lib-ecosim-teleport"),
  },
  {
    coordinate: "wendoo-lang/lib-ecosim-detect",
    dir: path.resolve(process.cwd(), "./extensions/lib-ecosim-detect"),
  },
];

export function embeddedExtensions() {
  return embeddedExtensionsVitePlugin(registrations);
}
