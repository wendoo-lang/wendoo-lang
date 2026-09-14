export * as brain from "./brain";
export type { ClientBuild, CoreBuild } from "./build-identity";
export { DEV_CLIENT_BUILD, DEV_TARGET_PACKAGE_VERSION, UNKNOWN_CORE_DIST_HASH } from "./build-identity";
export { assertUnreachable } from "./platform/assert";
export { Dict } from "./platform/dict";
export { Error } from "./platform/error";
// Platform utilities
export { List, type ReadonlyList } from "./platform/list";
export type { LogEntry, Logger } from "./platform/logger";
export { createLogger, LogLevel, logger } from "./platform/logger";
export { MathOps } from "./platform/math";
export * as stream from "./platform/stream";
export { StringUtils } from "./platform/string";
export { task, thread } from "./platform/task";
export { TypeUtils } from "./platform/types";
export { UniqueSet } from "./platform/uniqueset";
export { Vector2 } from "./platform/vector2";
export { Vector3 } from "./platform/vector3";
export * as primitives from "./primitives";
// Primitive utilities
export { fourCC, fromFourCC } from "./primitives";
export * as runtime from "./runtime";
export * as systems from "./systems";
export * as util from "./util";
export type { ReadonlyBitSet } from "./util/bitset";
export { BitSet } from "./util/bitset";
export type { EventListener } from "./util/event-emitter";
// Utility exports (also available via util namespace)
export { EventEmitter } from "./util/event-emitter";
export { MTree, MTreeBuilder, MTreeNode } from "./util/m-tree";
export { OpResult, opFailure, opSuccess } from "./util/op-result";
export type {
  ActionBundleUpdate,
  BrainInvalidationEvent,
  CompiledActionArtifact,
  CompiledActionBundle,
  CompiledRoot,
  ConversionDefinition,
  CreateBrainOptions,
  CreateHostActuatorOptions,
  CreateHostSensorOptions,
  HostActuatorDefinition,
  HostFunctionDefinition,
  HostSensorDefinition,
  HydratedTileMetadataSnapshot,
  OperatorDefinition,
  OperatorOverloadDefinition,
  TileDefinitionInput,
  WendooBrain,
  WendooCatalog,
  WendooEnvironment,
  WendooModule,
  WendooModuleApi,
  WendooTypeDefinition,
} from "./wendoo";
export {
  coreModule,
  createHostActuator,
  createHostSensor,
  createWendooEnvironment,
  withWendooEnvironmentServices,
} from "./wendoo";
