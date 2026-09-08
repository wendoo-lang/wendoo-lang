export type { TargetAdapter } from "../target/adapter.js";
export {
  createTargetAdapter,
  FAKE_BELL_CHANNEL,
  FAKE_INPUT_KIND,
  FAKE_RING_THINKS,
  FAKE_SIGNAL_CHANNEL,
  FAKE_SUBJECT,
  FAKE_TARGET_IDENTITY,
} from "./fake-adapter.js";
export type { FakeBell, FakeWorldState } from "./fake-module.js";
export {
  createFakeModule,
  FAKE_EMIT_OUTPUT,
  FAKE_LONG_UNIT,
  FAKE_SWATCH_LITERAL_FACTORY_ID,
  FakeActionKeys,
  FakeTileIds,
} from "./fake-module.js";
export { ruleIdAt } from "./rule-addressing.js";
