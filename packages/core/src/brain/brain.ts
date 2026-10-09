import { EventEmitter } from "../platform/event-emitter";
import { List } from "../platform/list";
import {
  type BrainEvents,
  type BrainLinkEnvironment,
  BrainRuntime,
  type IBrain,
  type PageMetadata,
  type VmEvents,
} from "../runtime";
import type { Program } from "../runtime/program";
import type { Value } from "../runtime/value";
import type { EventEmitterConsumer } from "../util";
import { BrainBuildError, runBrainLinkPipeline, summarizeBrainBuildDiagnostics } from "./compiler";
import type { IBrainDef, IBrainPageDef } from "./interfaces";
import { BrainPage } from "./page";
import type { BrainServices } from "./services";

/**
 * Live, running instance of a Wendoo brain. Compiles an {@link IBrainDef} through the compile,
 * link, and treeshake pipeline, constructs a {@link BrainRuntime} from the resulting program, and
 * delegates all runtime operations (think, variables, page lifecycle) to it.
 */
export class Brain implements IBrain {
  /** Runtime page instances */
  pages: List<BrainPage> = new List<BrainPage>();

  /** `BrainRuntime` instance constructed by {@link initialize}. */
  private runtime: BrainRuntime | undefined;

  /** Unsubscribe callbacks for the page-lifecycle event bridge registered in {@link initialize}. */
  private readonly unsubs: List<() => void> = new List<() => void>();

  /** Emitter returned by {@link events} before the first successful {@link initialize}, when no runtime exists yet. */
  private uninitializedEmitter: EventEmitter<BrainEvents> | undefined;

  constructor(
    public readonly brainDef: IBrainDef,
    private readonly services: BrainServices,
    private readonly linkEnvironment?: BrainLinkEnvironment
  ) {
    // Create runtime page instances
    brainDef.pages().forEach((pageDef: IBrainPageDef) => {
      const page = new BrainPage(this, pageDef);
      this.pages.push(page);
    });
  }

  events(): EventEmitterConsumer<BrainEvents> {
    if (this.runtime) {
      return this.runtime.events();
    }
    if (!this.uninitializedEmitter) {
      this.uninitializedEmitter = new EventEmitter<BrainEvents>();
    }
    return this.uninitializedEmitter;
  }

  /**
   * Compile the brain, link its actions, and initialize the VM.
   * Must be called before think() can execute rules.
   */
  initialize(contextData?: unknown, vmEvents?: VmEvents): void {
    const previousVariables = this.runtime?.snapshotVariables();

    const result = runBrainLinkPipeline(this.brainDef, this.getLinkEnvironment(), this.services.shared.conversions);
    if (!result.program) {
      throw new BrainBuildError(summarizeBrainBuildDiagnostics(result.diagnostics), result.diagnostics);
    }

    const { program, ruleIndex, pages: pageMetadata } = result.program;

    for (let pageIdx = 0; pageIdx < this.pages.size(); pageIdx++) {
      const page = this.pages.get(pageIdx)!;
      page.assignFuncIds(ruleIndex, pageIdx);
    }

    const hostServices = {
      runtime: this.services.runtime,
      shared: this.services.shared,
      app: this.services.app,
    };
    this.runtime = new BrainRuntime(program, pageMetadata, hostServices, contextData, previousVariables, vmEvents);

    this.unsubs.push(
      this.runtime.events().on("page_activated", ({ pageIndex }) => {
        this.pages.at(pageIndex)?.activate();
      })
    );
    this.unsubs.push(
      this.runtime.events().on("page_deactivated", ({ pageIndex }) => {
        this.pages.at(pageIndex)?.deactivate();
      })
    );
  }

  /**
   * Check if the brain has been initialized and is ready to execute.
   */
  isInitialized(): boolean {
    return this.runtime !== undefined;
  }

  /**
   * Get the linked executable program (for debugging/inspection).
   */
  getProgram(): Program | undefined {
    return this.runtime?.getProgram();
  }

  getPages(): List<PageMetadata> {
    return this.runtime?.getPages() ?? List.empty<PageMetadata>();
  }

  /**
   * Get a variable value by its name. The brain looks up the slot id assigned
   * to the name (either by the loaded program or lazily by a previous host
   * write) and returns the slot's current value, or `undefined` if the name
   * has never been associated with a slot.
   *
   * @param varId - Variable name
   * @returns The variable's current value, or undefined if not found
   */
  getVariable<T extends Value>(varId: string): T | undefined {
    return this.runtime?.getVariable<T>(varId);
  }

  getVariableBySlot(slotId: number): Value {
    return this.runtime!.getVariableBySlot(slotId);
  }

  /**
   * Set a variable value by its name. If the name is not yet bound to a slot,
   * a new slot is allocated and `varSlotByName` is extended. Slots allocated
   * this way are not addressable from bytecode (no `LOAD_VAR_SLOT` operand can
   * target them) -- only host functions that use the name-keyed API can read
   * them back.
   *
   * @param varId - Variable name
   * @param value - The value to store
   */
  setVariable(varId: string, value: Value): void {
    this.runtime?.setVariable(varId, value);
  }

  /**
   * Clear a variable by its name. Resets the underlying slot to a fresh copy
   * of its type's starting value, or to holding no value when the type
   * declares none; the slot itself is retained so subsequent bytecode
   * operands remain valid (a slot holding no value reads as `NIL_VALUE`).
   *
   * @param varId - Variable name
   */
  clearVariable(varId: string): void {
    this.runtime?.clearVariable(varId);
  }

  /**
   * Reset every slot to a fresh copy of its type's starting value, or to
   * holding no value when the type declares none, while preserving the
   * program-derived slot layout (slot ids and `varSlotByName` mappings
   * remain stable).
   */
  clearVariables(): void {
    this.runtime?.clearVariables();
  }

  setEnabled(enabled: boolean): void {
    this.runtime?.setEnabled(enabled);
  }

  isEnabled(): boolean {
    return this.runtime?.isEnabled() ?? true;
  }

  interrupt(): void {
    this.runtime?.interrupt();
  }

  clearInterrupt(): void {
    this.runtime?.clearInterrupt();
  }

  isInterrupted(): boolean {
    return this.runtime?.isInterrupted() ?? false;
  }

  requestPageChange(pageIndex: number): void {
    this.runtime?.requestPageChange(pageIndex);
  }

  requestPageChangeByPageId(pageId: string): void {
    this.runtime?.requestPageChangeByPageId(pageId);
  }

  requestPageChangeByName(name: string): void {
    this.runtime?.requestPageChangeByName(name);
  }

  requestPageRestart(): void {
    this.runtime?.requestPageRestart();
  }

  getCurrentPageId(): string {
    return this.runtime?.getCurrentPageId() ?? "";
  }

  getPreviousPageId(): string {
    return this.runtime?.getPreviousPageId() ?? "";
  }

  startup(): void {
    this.runtime?.startup();
  }

  shutdown(): void {
    this.runtime?.shutdown();
    this.unsubs.forEach((fn) => {
      fn();
    });
    this.unsubs.clear();
  }

  think(currentTime: number): void {
    this.runtime?.think(currentTime);
  }

  private getLinkEnvironment(): BrainLinkEnvironment {
    if (this.linkEnvironment) {
      return this.linkEnvironment;
    }

    return {
      catalogs: List.from([this.services.edit.tiles]),
      actionResolver: this.services.runtime.actions,
      typeRegistry: this.services.runtime.types,
    };
  }
}
