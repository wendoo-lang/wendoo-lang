import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  coreModule,
  createWendooEnvironment,
  List,
  type WendooEnvironment,
  type WendooModule,
  type WendooModuleApi,
} from "@wendoo/core";
import { type BrainServices, mkOperatorTileId, RuleSide } from "@wendoo/core/brain";
import { buildInsertionContext, suggestTiles } from "@wendoo/core/brain/language-service";
import { BrainDef, type BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainTileOperatorDef, BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import {
  CoreFuncId,
  CoreOpId,
  CoreTypeIds,
  mkTypeId,
  NativeType,
  Op,
  OperatorOverloadErrorCode,
  type OpId,
  TARGET_TYPE_ATOM_BASE,
  TRUE_VALUE,
  type TypeId,
} from "@wendoo/core/runtime";

/** Name of the struct type the extending module declares. */
const SPOT_TYPE_NAME = "Spot";

/** TypeId of the struct type the extending module declares. */
const SPOT_TYPE_ID = mkTypeId(NativeType.Struct, SPOT_TYPE_NAME);

/** FuncId of the `eq` overload over two `Spot` operands. */
const SPOT_EQ_FN_ID = 2201;

/** FuncId of a second `eq` overload over two `Spot` operands, which a duplicate registration offers. */
const SPOT_EQ_AGAIN_FN_ID = 2202;

/** FuncId of the `ne` overload over two `Spot` operands. */
const SPOT_NE_FN_ID = 2203;

/**
 * Adds to the operator `opId`, through the services' operator overloads, a
 * synchronous overload over `lhs` and `rhs` -- two `Spot` operands unless
 * given -- returning a boolean, implemented by the host function `fnId`.
 */
function addOverload(
  api: WendooModuleApi,
  opId: OpId,
  fnId: number,
  lhs: TypeId = SPOT_TYPE_ID,
  rhs: TypeId = SPOT_TYPE_ID
): void {
  api.brainServices.edit.operatorOverloads.binary(
    opId,
    lhs,
    rhs,
    CoreTypeIds.Boolean,
    fnId,
    { exec: () => TRUE_VALUE },
    false
  );
}

/**
 * A module declaring the closed struct type `Spot`, then running `extend`
 * against its install API, each error `extend` throws recorded in `errors`.
 */
function spotModule(extend: (api: WendooModuleApi) => void, errors: Error[] = []): WendooModule {
  return {
    id: "spot",
    install(api): void {
      api.defineType({
        coreType: NativeType.Struct,
        typeId: SPOT_TYPE_ID,
        name: SPOT_TYPE_NAME,
        atomId: TARGET_TYPE_ATOM_BASE,
        fields: List.from([{ name: "x", typeId: CoreTypeIds.Number, fieldIndex: 0 }]),
      });
      try {
        extend(api);
      } catch (error) {
        errors.push(error as Error);
      }
    },
  };
}

function servicesOf(environment: WendooEnvironment): BrainServices {
  return environment.brainServices;
}

/** The ids of every operator tile `environment`'s catalogs hold, sorted. */
function operatorTileIds(environment: WendooEnvironment): string[] {
  const ids: string[] = [];
  for (const catalog of environment.tileCatalogs()) {
    catalog.getAll().forEach((tile) => {
      if (tile.kind === "operator") ids.push(tile.tileId);
    });
  }
  return ids.sort();
}

/** A one-rule brain whose WHEN side holds a `Spot` variable tile, then `tail`'s tiles. */
function spotRuleBrain(
  environment: WendooEnvironment,
  tail: (brainDef: BrainDef) => (BrainTileOperatorDef | BrainTileVariableDef)[]
): { brainDef: BrainDef; rule: BrainRuleDef } {
  const brainDef = BrainDef.emptyBrainDef(servicesOf(environment), "Spots");
  const here = new BrainTileVariableDef("variable:spot.here", "here", SPOT_TYPE_ID, "here");
  brainDef.catalog().registerTileDef(here);
  const rule = brainDef.pages().get(0)!.children().get(0)! as BrainRuleDef;
  rule.when().appendTile(here);
  for (const tile of tail(brainDef)) rule.when().appendTile(tile);
  return { brainDef, rule };
}

/** Whether the candidate strip offers the core `opId` operator tile at the end of `rule`'s WHEN side. */
function offersOperator(environment: WendooEnvironment, brainDef: BrainDef, rule: BrainRuleDef, opId: string): boolean {
  brainDef.typecheck();
  const context = buildInsertionContext({
    side: RuleSide.When,
    expr: rule.when().expr(),
    ruleDef: rule,
    existingTiles: rule.when().tiles(),
  });
  const result = suggestTiles(context, List.from(environment.tileCatalogs()), servicesOf(environment));
  const wanted = mkOperatorTileId(opId);
  const has = (suggestions: typeof result.exact) =>
    suggestions.findIndex((suggestion) => suggestion.tileDef.tileId === wanted) !== -1;
  return has(result.exact) || has(result.withConversion);
}

describe("operator overload extension", () => {
  test("an overload a module adds to a core operator is one the compiler resolves", () => {
    const environment = createWendooEnvironment({
      modules: [
        coreModule(),
        spotModule((api) => {
          addOverload(api, CoreOpId.EqualTo, SPOT_EQ_FN_ID);
        }),
      ],
    });
    const services = servicesOf(environment);

    const resolved = services.edit.operatorOverloads.resolve(CoreOpId.EqualTo, [SPOT_TYPE_ID, SPOT_TYPE_ID]);
    assert.equal(resolved?.overload.fnEntry?.id, SPOT_EQ_FN_ID);
    assert.equal(resolved?.overload.resultType, CoreTypeIds.Boolean);
    assert.equal(
      services.edit.operatorOverloads.resolve(CoreOpId.EqualTo, [CoreTypeIds.Number, CoreTypeIds.Number])?.overload
        .fnEntry?.id,
      CoreFuncId.OpEqualToNumber
    );

    const { brainDef } = spotRuleBrain(environment, (def) => {
      const there = new BrainTileVariableDef("variable:spot.there", "there", SPOT_TYPE_ID, "there");
      def.catalog().registerTileDef(there);
      return [new BrainTileOperatorDef(CoreOpId.EqualTo, {}, services), there];
    });
    const linked = environment.linkBrain(brainDef);
    assert.equal(linked.diagnostics.size(), 0);
    const calls: number[] = [];
    linked.program!.program.functions.forEach((fn) => {
      fn.code.forEach((instr) => {
        if (instr.op === Op.HOST_CALL) calls.push(instr.a!);
      });
    });
    assert.ok(calls.includes(SPOT_EQ_FN_ID), `expected a HOST_CALL of ${SPOT_EQ_FN_ID}, got ${calls.join(",")}`);
  });

  test("adding an overload mints no tile and leaves the operator's parse standing", () => {
    const plain = createWendooEnvironment({ modules: [coreModule(), spotModule(() => {})] });
    const extended = createWendooEnvironment({
      modules: [
        coreModule(),
        spotModule((api) => {
          addOverload(api, CoreOpId.EqualTo, SPOT_EQ_FN_ID);
        }),
      ],
    });

    assert.deepEqual(operatorTileIds(extended), operatorTileIds(plain));
    assert.deepEqual(
      servicesOf(extended).runtime.operatorTable.get(CoreOpId.EqualTo)?.parse,
      servicesOf(plain).runtime.operatorTable.get(CoreOpId.EqualTo)?.parse
    );
  });

  test("the strip offers eq after an expression of a type with an eq overload, and withholds it without one", () => {
    const plain = createWendooEnvironment({ modules: [coreModule(), spotModule(() => {})] });
    const extended = createWendooEnvironment({
      modules: [
        coreModule(),
        spotModule((api) => {
          addOverload(api, CoreOpId.EqualTo, SPOT_EQ_FN_ID);
        }),
      ],
    });

    const withOverload = spotRuleBrain(extended, () => []);
    const withoutOverload = spotRuleBrain(plain, () => []);
    assert.equal(offersOperator(extended, withOverload.brainDef, withOverload.rule, CoreOpId.EqualTo), true);
    assert.equal(offersOperator(plain, withoutOverload.brainDef, withoutOverload.rule, CoreOpId.EqualTo), false);
  });

  test("a duplicate overload is refused by stable code and the first registration stands", () => {
    const errors: Error[] = [];
    const environment = createWendooEnvironment({
      modules: [
        coreModule(),
        spotModule((api) => {
          addOverload(api, CoreOpId.EqualTo, SPOT_EQ_FN_ID);
          addOverload(api, CoreOpId.EqualTo, SPOT_EQ_AGAIN_FN_ID);
        }, errors),
      ],
    });
    const services = servicesOf(environment);

    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.startsWith(OperatorOverloadErrorCode.Duplicate), errors[0].message);
    const resolved = services.edit.operatorOverloads.resolve(CoreOpId.EqualTo, [SPOT_TYPE_ID, SPOT_TYPE_ID]);
    assert.equal(resolved?.overload.fnEntry?.id, SPOT_EQ_FN_ID);
    assert.equal(services.runtime.functions.getSyncById(SPOT_EQ_AGAIN_FN_ID), undefined);
  });

  test("an overload duplicating a core overload is refused by stable code and the core overload stands", () => {
    const errors: Error[] = [];
    const environment = createWendooEnvironment({
      modules: [
        coreModule(),
        spotModule((api) => {
          addOverload(api, CoreOpId.EqualTo, SPOT_EQ_AGAIN_FN_ID, CoreTypeIds.Number, CoreTypeIds.Number);
        }, errors),
      ],
    });
    const services = servicesOf(environment);

    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.startsWith(OperatorOverloadErrorCode.Duplicate), errors[0].message);
    const resolved = services.edit.operatorOverloads.resolve(CoreOpId.EqualTo, [
      CoreTypeIds.Number,
      CoreTypeIds.Number,
    ]);
    assert.equal(resolved?.overload.fnEntry?.id, CoreFuncId.OpEqualToNumber);
    assert.equal(services.runtime.functions.getSyncById(SPOT_EQ_AGAIN_FN_ID), undefined);
  });

  test("an overload naming an operator the environment does not hold is refused by stable code", () => {
    const errors: Error[] = [];
    const environment = createWendooEnvironment({
      modules: [
        coreModule(),
        spotModule((api) => {
          addOverload(api, "spot.same", SPOT_EQ_FN_ID);
        }, errors),
      ],
    });

    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.startsWith(OperatorOverloadErrorCode.UnknownOperator), errors[0].message);
    assert.equal(servicesOf(environment).runtime.operatorTable.get("spot.same"), undefined);
    assert.equal(servicesOf(environment).runtime.functions.getSyncById(SPOT_EQ_FN_ID), undefined);
  });

  test("ne carries its own overloads: an eq extension leaves ne unresolved until ne is extended", () => {
    const eqOnly = createWendooEnvironment({
      modules: [
        coreModule(),
        spotModule((api) => {
          addOverload(api, CoreOpId.EqualTo, SPOT_EQ_FN_ID);
        }),
      ],
    });
    const both = createWendooEnvironment({
      modules: [
        coreModule(),
        spotModule((api) => {
          addOverload(api, CoreOpId.EqualTo, SPOT_EQ_FN_ID);
          addOverload(api, CoreOpId.NotEqualTo, SPOT_NE_FN_ID);
        }),
      ],
    });

    const spots = [SPOT_TYPE_ID, SPOT_TYPE_ID];
    assert.equal(servicesOf(eqOnly).edit.operatorOverloads.resolve(CoreOpId.NotEqualTo, spots), undefined);
    assert.equal(
      servicesOf(both).edit.operatorOverloads.resolve(CoreOpId.NotEqualTo, spots)?.overload.fnEntry?.id,
      SPOT_NE_FN_ID
    );
  });

  test("an eq extension leaves every nil equality overload standing and admits no nil operand of its own", () => {
    const environment = createWendooEnvironment({
      modules: [
        coreModule(),
        spotModule((api) => {
          addOverload(api, CoreOpId.EqualTo, SPOT_EQ_FN_ID);
        }),
      ],
    });
    const overloads = servicesOf(environment).edit.operatorOverloads;
    const fnIdOf = (argTypes: string[]) => overloads.resolve(CoreOpId.EqualTo, argTypes)?.overload.fnEntry?.id;

    assert.equal(fnIdOf([CoreTypeIds.Nil, CoreTypeIds.Nil]), CoreFuncId.OpEqualToNil);
    assert.equal(fnIdOf([CoreTypeIds.Number, CoreTypeIds.Nil]), CoreFuncId.OpEqualToNumberNil);
    assert.equal(fnIdOf([CoreTypeIds.Nil, CoreTypeIds.Number]), CoreFuncId.OpEqualToNilNumber);
    assert.equal(fnIdOf([CoreTypeIds.String, CoreTypeIds.Nil]), CoreFuncId.OpEqualToStringNil);
    assert.equal(fnIdOf([SPOT_TYPE_ID, CoreTypeIds.Nil]), undefined);
    assert.equal(fnIdOf([CoreTypeIds.Nil, SPOT_TYPE_ID]), undefined);
  });
});
