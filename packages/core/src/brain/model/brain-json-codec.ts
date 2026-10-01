import { Dict } from "../../platform/dict";
import { Error } from "../../platform/error";
import { List, type ReadonlyList } from "../../platform/list";
import { StringUtils as SU } from "../../platform/string";
import { TypeUtils } from "../../platform/types";
import type { ITypeRegistry, TypeId } from "../../runtime";
import {
  mkConstructedTypeName,
  mkFunctionTypeName,
  mkNamespacedTypeName,
  mkNullableTypeName,
  mkTypeId,
  mkUnionTypeName,
  splitNamespacedTypeName,
} from "../../runtime/core-types";
import {
  mkAnonParameterId,
  mkParameterTileId,
  mkPrivateArgId,
  mkScopedOutputName,
  mkTileId,
  mkUserActionKey,
  parseTileId,
} from "../../runtime/tile-ids";
import {
  type FunctionTypeDef,
  type ListTypeDef,
  type MapTypeDef,
  NativeType,
  type NullableTypeDef,
  nativeTypeFromString,
  nativeTypeToString,
  type UnionTypeDef,
} from "../../runtime/type-defs";
import {
  type IBrainDef,
  type IBrainRuleDef,
  type IBrainTileDef,
  type ITileCatalog,
  LiteralDisplayFormats,
  mkAccessorTileId,
  mkLiteralTileId,
  mkOutputTileId,
  mkPageTileId,
  mkUniqueLiteralTileId,
  mkVariableTileId,
} from "../interfaces";
import type { BrainServices } from "../services";
import type { BrainTileAccessorDef } from "../tiles/accessors";
import type { BrainTileActuatorDef } from "../tiles/actuators";
import type { CatalogTileJson } from "../tiles/catalog";
import type { BrainTileLiteralDef, LiteralTileJson } from "../tiles/literals";
import type { BrainTileModifierDef } from "../tiles/modifiers";
import type { BrainTileOutputDef } from "../tiles/outputs";
import type { PageTileJson } from "../tiles/pagetiles";
import type { BrainTileParameterDef } from "../tiles/parameters";
import type { BrainTileSensorDef } from "../tiles/sensors";
import type {
  PersistedBrainJson,
  PersistedCatalogTileJson,
  PersistedIdRef,
  PersistedLiteralTileJson,
  PersistedPageJson,
  PersistedPageTileJson,
  PersistedRuleJson,
  PersistedTileRef,
  PersistedTypeRef,
} from "./brain-json-persisted";
import { BrainDef, type BrainJson } from "./braindef";
import type { PageJson } from "./pagedef";
import type { RuleJson } from "./ruledef";

/** Stable error codes thrown by the persisted brain JSON codec. */
export const BrainJsonCodecErrorCode = {
  /** A plain-string id position carries the owning project's namespace; self ids must be structured with the namespace absent. */
  SelfNamespaceInPlainId: "BRAIN_JSON_SELF_NAMESPACE_IN_PLAIN_ID",
  /** An id carries a namespace but no components are available to structure it. */
  NamespacedIdNotStructurable: "BRAIN_JSON_NAMESPACED_ID_NOT_STRUCTURABLE",
  /** A persisted reference has an invalid shape. */
  InvalidPersistedRef: "BRAIN_JSON_INVALID_PERSISTED_REF",
  /** A decoded tile id is not shape-valid. */
  InvalidTileId: "BRAIN_JSON_INVALID_TILE_ID",
} as const;

/** Union of all {@link BrainJsonCodecErrorCode} values. */
export type BrainJsonCodecErrorCode = (typeof BrainJsonCodecErrorCode)[keyof typeof BrainJsonCodecErrorCode];

function codecError(code: BrainJsonCodecErrorCode, detail: string): Error {
  return new Error(`${code}: ${detail}`);
}

// Markers a namespaced identifier always carries: `<ns>:user.` in action keys
// and private arg ids, `<ns>:/` in user type names. A plain-string id position
// must contain neither.
const kUserKeyMarker = ":user.";
const kTypeNameMarker = ":/";

// -- Encoding -----------------------------------------------------------------

class BrainJsonEncoder {
  constructor(
    private readonly registry: ITypeRegistry,
    private readonly idRefs: Dict<string, PersistedIdRef>,
    private readonly owningNamespace: string
  ) {}

  /** Namespace field value for a structured ref: absent for self, the namespace for foreign. */
  private nsField(namespace: string): string | undefined {
    return namespace === this.owningNamespace ? undefined : namespace;
  }

  /**
   * The error code emitting `id` as a plain string would violate, or undefined
   * when `id` carries no namespace content: neither the owning namespace nor a
   * namespace marker.
   */
  private namespaceContentIn(id: string): BrainJsonCodecErrorCode | undefined {
    if (SU.indexOf(id, `${this.owningNamespace}:`) >= 0) {
      return BrainJsonCodecErrorCode.SelfNamespaceInPlainId;
    }
    if (SU.indexOf(id, kUserKeyMarker) >= 0 || SU.indexOf(id, kTypeNameMarker) >= 0) {
      return BrainJsonCodecErrorCode.NamespacedIdNotStructurable;
    }
    return undefined;
  }

  /** Emit a plain-string id, enforcing that it carries no namespace content. */
  private plainId(id: string, position: string): string {
    const violation = this.namespaceContentIn(id);
    if (violation === undefined) return id;
    const detail =
      violation === BrainJsonCodecErrorCode.SelfNamespaceInPlainId
        ? `carries the owning namespace '${this.owningNamespace}'`
        : "carries a namespace but no components are available to structure it";
    throw codecError(violation, `${position} '${id}' ${detail}`);
  }

  /** Emit an unresolved tile's preserved id when no structured ref is known for it. */
  private plainMissingId(id: string): string {
    if (SU.indexOf(id, `${this.owningNamespace}:`) >= 0) {
      throw codecError(
        BrainJsonCodecErrorCode.SelfNamespaceInPlainId,
        `missing tile id '${id}' carries the owning namespace '${this.owningNamespace}'`
      );
    }
    return id;
  }

  encodeTypeRefById(typeId: TypeId, position: string): PersistedTypeRef {
    const def = this.registry.get(typeId);
    if (!def) {
      const preserved = this.idRefs.get(typeId);
      if (preserved) return preserved as PersistedTypeRef;
      return this.plainId(typeId, position);
    }

    if (def.nullable) {
      const base = this.encodeTypeRefById((def as NullableTypeDef).baseTypeId, position);
      if (TypeUtils.isString(base)) return this.plainId(typeId, position);
      return { k: "nullable", base };
    }

    if (def.coreType === NativeType.Union) {
      const memberIds = (def as UnionTypeDef).memberTypeIds;
      const members: PersistedTypeRef[] = [];
      let structured = false;
      memberIds.forEach((memberId) => {
        const member = this.encodeTypeRefById(memberId, position);
        if (!TypeUtils.isString(member)) structured = true;
        members.push(member);
      });
      if (!structured) return this.plainId(typeId, position);
      return { k: "union", members };
    }

    if (def.coreType === NativeType.Function && (def as FunctionTypeDef).paramTypeIds !== undefined) {
      const fnDef = def as FunctionTypeDef;
      const params: PersistedTypeRef[] = [];
      let structured = false;
      fnDef.paramTypeIds.forEach((paramId) => {
        const param = this.encodeTypeRefById(paramId, position);
        if (!TypeUtils.isString(param)) structured = true;
        params.push(param);
      });
      const ret = this.encodeTypeRefById(fnDef.returnTypeId, position);
      if (!TypeUtils.isString(ret)) structured = true;
      if (!structured) return this.plainId(typeId, position);
      return { k: "function", params, ret };
    }

    if (def.coreType === NativeType.List && def.autoInstantiated) {
      const el = this.encodeTypeRefById((def as ListTypeDef).elementTypeId, position);
      if (TypeUtils.isString(el)) return this.plainId(typeId, position);
      return { k: "list", el };
    }

    if (def.coreType === NativeType.Map && def.autoInstantiated) {
      const mapDef = def as MapTypeDef;
      const key = this.encodeTypeRefById(mapDef.keyTypeId, position);
      const val = this.encodeTypeRefById(mapDef.valueTypeId, position);
      if (TypeUtils.isString(key) && TypeUtils.isString(val)) return this.plainId(typeId, position);
      return { k: "map", key, val };
    }

    const split = splitNamespacedTypeName(def.name);
    if (!split) return this.plainId(typeId, position);
    return {
      k: "named",
      t: nativeTypeToString(def.coreType),
      name: split.localName,
      ns: this.nsField(split.namespace!),
    };
  }

  encodeTileRef(tileDef: IBrainTileDef): PersistedTileRef {
    const kind = tileDef.kind;
    switch (kind) {
      case "sensor":
      case "actuator": {
        const identity = (tileDef as BrainTileSensorDef | BrainTileActuatorDef).userIdentity;
        if (identity) {
          return { k: "action", area: kind, id: identity.actionId, ns: this.nsField(identity.namespace) };
        }
        return this.plainId(tileDef.tileId, `${kind} tile id`);
      }
      case "parameter": {
        const paramDef = tileDef as BrainTileParameterDef;
        if (paramDef.userArg) {
          const arg = paramDef.userArg;
          return {
            k: "arg",
            area: "parameter",
            action: arg.actionId,
            name: arg.argName,
            ns: this.nsField(arg.namespace),
          };
        }
        if (paramDef.anonType?.namespace !== undefined) {
          return { k: "anon", name: paramDef.anonType.localName, ns: this.nsField(paramDef.anonType.namespace) };
        }
        return this.plainId(tileDef.tileId, "parameter tile id");
      }
      case "modifier": {
        const modifierDef = tileDef as BrainTileModifierDef;
        if (modifierDef.userArg) {
          const arg = modifierDef.userArg;
          return {
            k: "arg",
            area: "modifier",
            action: arg.actionId,
            name: arg.argName,
            ns: this.nsField(arg.namespace),
          };
        }
        return this.plainId(tileDef.tileId, "modifier tile id");
      }
      case "accessor": {
        const accessorDef = tileDef as BrainTileAccessorDef;
        const typeRef = this.encodeTypeRefById(accessorDef.structTypeId, "accessor struct type");
        if (TypeUtils.isString(typeRef)) return this.plainId(tileDef.tileId, "accessor tile id");
        return { k: "accessor", type: typeRef, field: accessorDef.fieldName };
      }
      case "output": {
        const outputDef = tileDef as BrainTileOutputDef;
        const typeRef = this.encodeTypeRefById(outputDef.outputType, "output type");
        if (outputDef.namespace === undefined) {
          if (TypeUtils.isString(typeRef)) return this.plainId(tileDef.tileId, "output tile id");
          throw codecError(
            BrainJsonCodecErrorCode.NamespacedIdNotStructurable,
            `output tile '${tileDef.tileId}' has a namespaced type but no owning namespace`
          );
        }
        return { k: "out", type: typeRef, name: outputDef.outputName, ns: this.nsField(outputDef.namespace) };
      }
      case "literal": {
        const literalDef = tileDef as BrainTileLiteralDef;
        if (literalDef.uniqueId !== undefined) return this.plainId(tileDef.tileId, "literal tile id");
        const typeRef = this.encodeTypeRefById(literalDef.valueType, "literal value type");
        // A label that reads as namespace content is stored in the structured
        // ref's label field.
        if (TypeUtils.isString(typeRef) && this.namespaceContentIn(tileDef.tileId) === undefined) return tileDef.tileId;
        return {
          k: "literal",
          type: typeRef,
          label: literalDef.valueLabel,
          format: literalDef.displayFormat === LiteralDisplayFormats.Default ? undefined : literalDef.displayFormat,
        };
      }
      case "missing": {
        const preserved = this.idRefs.get(tileDef.tileId);
        if (preserved) return preserved as PersistedTileRef;
        return this.plainMissingId(tileDef.tileId);
      }
      case "variable":
      case "page":
      case "operator":
      case "controlFlow":
      case "factory":
      case "undefined":
        return this.plainId(tileDef.tileId, `${kind} tile id`);
      default: {
        const unhandled: never = kind;
        throw codecError(BrainJsonCodecErrorCode.InvalidPersistedRef, `unhandled tile kind '${unhandled}'`);
      }
    }
  }

  encodeCatalogEntry(entry: CatalogTileJson): PersistedCatalogTileJson {
    switch (entry.kind) {
      case "literal": {
        const result: PersistedLiteralTileJson = {
          version: entry.version,
          kind: "literal",
          valueType: this.encodeTypeRefById(entry.valueType as TypeId, "literal value type"),
          value: entry.value,
          valueLabel: entry.valueLabel,
          displayFormat: entry.displayFormat,
        };
        if (entry.displayName !== undefined) result.displayName = entry.displayName;
        if (entry.uniqueId !== undefined) result.uniqueId = entry.uniqueId;
        return result;
      }
      case "variable":
        return {
          version: entry.version,
          kind: "variable",
          varName: entry.varName,
          varType: this.encodeTypeRefById(entry.varType as TypeId, "variable type"),
          uniqueId: entry.uniqueId,
        };
      case "page": {
        const result: PersistedPageTileJson = { version: entry.version, kind: "page", pageId: entry.pageId };
        if (entry.label !== undefined) result.label = entry.label;
        return result;
      }
      case "missing": {
        const preserved = this.idRefs.get(entry.tileId);
        return {
          version: entry.version,
          kind: "missing",
          tileId: preserved ? (preserved as PersistedTileRef) : this.plainMissingId(entry.tileId),
          originalKind: entry.originalKind,
          label: entry.label,
        };
      }
      default: {
        const unhandled: never = entry;
        throw codecError(
          BrainJsonCodecErrorCode.InvalidPersistedRef,
          `unhandled catalog entry kind '${(unhandled as CatalogTileJson).kind}'`
        );
      }
    }
  }

  encodeRule(rule: IBrainRuleDef, ruleJson: RuleJson): PersistedRuleJson {
    const encodeSide = (tiles: ReadonlyList<IBrainTileDef>): PersistedTileRef[] => {
      const refs: PersistedTileRef[] = [];
      tiles.forEach((tileDef) => {
        refs.push(this.encodeTileRef(tileDef));
      });
      return refs;
    };
    const children: PersistedRuleJson[] = [];
    const childRules = rule.children();
    for (let i = 0; i < childRules.size(); i++) {
      children.push(this.encodeRule(childRules.get(i), ruleJson.children.get(i)));
    }
    const result: PersistedRuleJson = {
      version: ruleJson.version,
      when: encodeSide(rule.when().tiles()),
      do: encodeSide(rule.do().tiles()),
      children,
    };
    if (ruleJson.ruleId !== undefined) result.ruleId = ruleJson.ruleId;
    if (ruleJson.comment !== undefined) result.comment = ruleJson.comment;
    if (ruleJson.trigger !== undefined) result.trigger = ruleJson.trigger;
    return result;
  }
}

/**
 * Serialize a brain definition into its persisted JSON form for the project
 * identified by `projectNamespace`. Identifiers qualified by that namespace
 * serialize with the namespace absent; identifiers qualified by any other
 * namespace carry it as a field. Throws when an identifier carries a
 * namespace that cannot be structured from the model.
 */
export function encodePersistedBrainJson(brainDef: IBrainDef, projectNamespace: string): PersistedBrainJson {
  const model = brainDef as BrainDef;
  const json = model.toJson();
  const encoder = new BrainJsonEncoder(model.servicesTypeRegistry(), model.persistedIdRefs(), projectNamespace);

  const catalog: PersistedCatalogTileJson[] = [];
  json.catalog.forEach((entry) => {
    catalog.push(encoder.encodeCatalogEntry(entry));
  });

  const pages: PersistedPageJson[] = [];
  const modelPages = model.pages();
  for (let i = 0; i < modelPages.size(); i++) {
    const page = modelPages.get(i);
    const pageJson = json.pages.get(i);
    const rules: PersistedRuleJson[] = [];
    const modelRules = page.children();
    for (let j = 0; j < modelRules.size(); j++) {
      rules.push(encoder.encodeRule(modelRules.get(j), pageJson.rules.get(j)));
    }
    pages.push({ version: pageJson.version, pageId: pageJson.pageId, name: pageJson.name, rules });
  }

  return { version: json.version, id: json.id, name: json.name, catalog, pages };
}

// -- Decoding -----------------------------------------------------------------

interface DecodedType {
  typeId: TypeId;
  name?: string;
  coreType?: NativeType;
}

class BrainJsonDecoder {
  readonly idRefs = new Dict<string, PersistedIdRef>();

  constructor(private readonly projectNamespace: string) {}

  private namespaceOf(ns: string | undefined): string {
    return ns ?? this.projectNamespace;
  }

  decodeTypeRef(ref: PersistedTypeRef): DecodedType {
    if (TypeUtils.isString(ref)) {
      return { typeId: ref };
    }
    switch (ref.k) {
      case "named": {
        const coreType = nativeTypeFromString(ref.t);
        if (coreType === undefined) {
          throw codecError(BrainJsonCodecErrorCode.InvalidPersistedRef, `unknown native type '${ref.t}'`);
        }
        const name = mkNamespacedTypeName(this.namespaceOf(ref.ns), ref.name);
        return { typeId: this.record(mkTypeId(coreType, name), ref), name, coreType };
      }
      case "nullable": {
        const base = this.decodeTypeRef(ref.base);
        if (base.name === undefined || base.coreType === undefined) {
          throw codecError(
            BrainJsonCodecErrorCode.InvalidPersistedRef,
            "structured nullable ref requires a structured base"
          );
        }
        const name = mkNullableTypeName(base.name);
        return { typeId: this.record(mkTypeId(base.coreType, name), ref), name, coreType: base.coreType };
      }
      case "list": {
        const el = this.decodeTypeRef(ref.el);
        const name = mkConstructedTypeName("List", List.from([el.typeId]));
        return { typeId: this.record(mkTypeId(NativeType.List, name), ref), name, coreType: NativeType.List };
      }
      case "map": {
        const key = this.decodeTypeRef(ref.key);
        const val = this.decodeTypeRef(ref.val);
        const name = mkConstructedTypeName("Map", List.from([key.typeId, val.typeId]));
        return { typeId: this.record(mkTypeId(NativeType.Map, name), ref), name, coreType: NativeType.Map };
      }
      case "union": {
        const memberIds: string[] = [];
        for (const member of ref.members) {
          memberIds.push(this.decodeTypeRef(member).typeId);
        }
        // The registry mints union names from lexicographically sorted member
        // ids; re-minted member ids must be re-sorted to match.
        const sorted = List.from(memberIds.sort());
        const name = mkUnionTypeName(sorted);
        return { typeId: this.record(mkTypeId(NativeType.Union, name), ref), name, coreType: NativeType.Union };
      }
      case "function": {
        const paramIds = new List<string>();
        for (const param of ref.params) {
          paramIds.push(this.decodeTypeRef(param).typeId);
        }
        const ret = this.decodeTypeRef(ref.ret);
        const name = mkFunctionTypeName(paramIds, ret.typeId);
        return { typeId: this.record(mkTypeId(NativeType.Function, name), ref), name, coreType: NativeType.Function };
      }
      default: {
        const unhandled: never = ref;
        throw codecError(
          BrainJsonCodecErrorCode.InvalidPersistedRef,
          `unknown type ref kind '${(unhandled as { k: string }).k}'`
        );
      }
    }
  }

  decodeTileRef(ref: PersistedTileRef): string {
    if (TypeUtils.isString(ref)) {
      return this.assertTileIdShape(ref);
    }
    switch (ref.k) {
      case "action":
        return this.recordTile(mkTileId(ref.area, mkUserActionKey(this.namespaceOf(ref.ns), ref.area, ref.id)), ref);
      case "arg":
        return this.recordTile(mkTileId(ref.area, mkPrivateArgId(this.namespaceOf(ref.ns), ref.action, ref.name)), ref);
      case "anon":
        return this.recordTile(
          mkParameterTileId(mkAnonParameterId(mkNamespacedTypeName(this.namespaceOf(ref.ns), ref.name))),
          ref
        );
      case "accessor":
        return this.recordTile(mkAccessorTileId(this.decodeTypeRef(ref.type).typeId, ref.field), ref);
      case "out":
        return this.recordTile(
          mkOutputTileId(this.decodeTypeRef(ref.type).typeId, mkScopedOutputName(this.namespaceOf(ref.ns), ref.name)),
          ref
        );
      case "literal":
        return this.recordTile(mkLiteralTileId(this.decodeTypeRef(ref.type).typeId, ref.label, ref.format), ref);
      default: {
        const unhandled: never = ref;
        throw codecError(
          BrainJsonCodecErrorCode.InvalidPersistedRef,
          `unknown tile ref kind '${(unhandled as { k: string }).k}'`
        );
      }
    }
  }

  private record(typeId: TypeId, ref: Exclude<PersistedTypeRef, string>): TypeId {
    this.idRefs.set(typeId, ref);
    return typeId;
  }

  private recordTile(tileId: string, ref: Exclude<PersistedTileRef, string>): string {
    this.idRefs.set(this.assertTileIdShape(tileId), ref);
    return tileId;
  }

  private assertTileIdShape(tileId: string): string {
    if (!parseTileId(tileId)) {
      throw codecError(BrainJsonCodecErrorCode.InvalidTileId, `'${tileId}' is not a valid tile id`);
    }
    return tileId;
  }

  decodeCatalogEntry(entry: PersistedCatalogTileJson): CatalogTileJson {
    switch (entry.kind) {
      case "literal": {
        const typeId = this.decodeTypeRef(entry.valueType).typeId;
        const tileId =
          entry.uniqueId === undefined
            ? mkLiteralTileId(
                typeId,
                entry.valueLabel,
                entry.displayFormat === LiteralDisplayFormats.Default ? undefined : entry.displayFormat
              )
            : mkUniqueLiteralTileId(entry.uniqueId);
        const result: LiteralTileJson = {
          version: entry.version,
          kind: "literal",
          tileId,
          valueType: typeId,
          value: entry.value,
          valueLabel: entry.valueLabel,
          displayFormat: entry.displayFormat,
        };
        if (entry.displayName !== undefined) result.displayName = entry.displayName;
        if (entry.uniqueId !== undefined) result.uniqueId = entry.uniqueId;
        return result;
      }
      case "variable":
        return {
          version: entry.version,
          kind: "variable",
          tileId: mkVariableTileId(entry.uniqueId),
          varName: entry.varName,
          varType: this.decodeTypeRef(entry.varType).typeId,
          uniqueId: entry.uniqueId,
        };
      case "page": {
        const result: PageTileJson = {
          version: entry.version,
          kind: "page",
          tileId: mkPageTileId(entry.pageId),
          pageId: entry.pageId,
        };
        if (entry.label !== undefined) result.label = entry.label;
        return result;
      }
      case "missing":
        return {
          version: entry.version,
          kind: "missing",
          tileId: this.decodeTileRef(entry.tileId),
          originalKind: entry.originalKind,
          label: entry.label,
        };
      default: {
        const unhandled: never = entry;
        throw codecError(
          BrainJsonCodecErrorCode.InvalidPersistedRef,
          `unknown catalog entry kind '${(unhandled as { kind: string }).kind}'`
        );
      }
    }
  }

  decodeRule(rule: PersistedRuleJson): RuleJson {
    const decodeSide = (refs: readonly PersistedTileRef[] | undefined): List<string> => {
      const tileIds = new List<string>();
      if (refs) {
        for (const ref of refs) {
          tileIds.push(this.decodeTileRef(ref));
        }
      }
      return tileIds;
    };
    const children = new List<RuleJson>();
    if (rule.children) {
      for (const child of rule.children) {
        children.push(this.decodeRule(child));
      }
    }
    const result: RuleJson = {
      version: rule.version,
      when: decodeSide(rule.when),
      do: decodeSide(rule.do),
      children,
    };
    if (rule.ruleId !== undefined) result.ruleId = rule.ruleId;
    if (rule.comment !== undefined) result.comment = rule.comment;
    if (rule.trigger !== undefined) result.trigger = rule.trigger;
    return result;
  }
}

/** Result of {@link decodePersistedBrainJson}. */
export interface DecodedPersistedBrain {
  /** In-memory brain JSON with fully qualified runtime identifiers. */
  json: BrainJson;
  /** Every structured persisted reference, keyed by the runtime id it minted. */
  idRefs: Dict<string, PersistedIdRef>;
}

/**
 * Decode the raw `JSON.parse` output of persisted brain JSON into in-memory
 * {@link BrainJson} for the project identified by `projectNamespace`.
 * Structured references re-mint fully qualified runtime identifiers: the
 * loading project's namespace for refs whose namespace field is absent, the
 * carried namespace otherwise.
 */
export function decodePersistedBrainJson(plain: unknown, projectNamespace: string): DecodedPersistedBrain {
  const raw = plain as PersistedBrainJson;
  const decoder = new BrainJsonDecoder(projectNamespace);

  const catalog = new List<CatalogTileJson>();
  for (const entry of raw.catalog ?? []) {
    catalog.push(decoder.decodeCatalogEntry(entry));
  }

  const pages = new List<PageJson>();
  for (const page of raw.pages ?? []) {
    const rules = new List<RuleJson>();
    for (const rule of page.rules ?? []) {
      rules.push(decoder.decodeRule(rule));
    }
    pages.push({ version: page.version, pageId: page.pageId, name: page.name, rules });
  }

  return {
    json: { version: raw.version, id: raw.id, name: raw.name, catalog, pages },
    idRefs: decoder.idRefs,
  };
}

/**
 * Decode persisted brain JSON and build a {@link BrainDef} from it, resolving
 * tiles against the brain's catalog chain plus `extraCatalogs`. The decoded
 * structured references are retained on the brain so unresolved identifiers
 * keep their persisted identity on the next serialization.
 */
export function deserializePersistedBrainJson(
  plain: unknown,
  projectNamespace: string,
  services: BrainServices,
  extraCatalogs?: ReadonlyList<ITileCatalog>
): BrainDef {
  const decoded = decodePersistedBrainJson(plain, projectNamespace);
  const brainDef = BrainDef.fromJson(decoded.json, services, extraCatalogs);
  const refs = brainDef.persistedIdRefs();
  decoded.idRefs.forEach((ref, id) => {
    refs.set(id, ref);
  });
  return brainDef;
}
