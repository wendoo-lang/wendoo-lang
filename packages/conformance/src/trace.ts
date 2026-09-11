/**
 * Observable trace: a deterministic, line-oriented ASCII rendering of one VM
 * run's externally observable effects under a scripted input schedule. Two VM
 * implementations fed the same program and schedule produce byte-identical
 * traces; the committed trace beside a corpus program is the behavioral
 * contract a separately built VM is verified against.
 *
 * This module carries the core line kinds only -- the ones any VM emits from
 * the shared `VmEvents` seam and the replayed schedule.
 *
 * Trace format, version 1 (LOCKED; any change bumps
 * {@link OBSERVABLE_TRACE_FORMAT_VERSION} and regenerates every committed
 * trace):
 *
 * - The trace is ASCII with LF line endings and ends with a trailing LF.
 *   Tokens on a line are separated by single spaces; lines are not indented.
 * - Integer scalars (tick ordinals, action ids, call-site ids, argument
 *   counts, fiber ids, fault codes) render as the minimal lowercase
 *   hexadecimal of their unsigned 32-bit value with no prefix or padding
 *   ("0" for zero).
 * - Brain-observable numbers (tick time/dt stamps, number-typed action
 *   arguments and results) render as the IEEE-754 bit pattern of the value at
 *   the trace's profile precision: 8 zero-padded lowercase hex digits of the
 *   f32 bits on an f32 profile, 16 digits of the f64 bits on an f64 profile.
 * - Strings render as a double-quoted UTF-8 byte sequence: bytes 0x20..0x7e
 *   are literal except `"` (renders `\"`) and `\` (renders `\\`); every
 *   other byte renders as `\xNN` with two lowercase hex digits.
 * - A value token is one of `void`, `nil`, `bool 0|1`, `number <bits>`,
 *   `string "<bytes>"`, `enum "<symbol>"` (the symbol's name, quoted as a
 *   string; the enum's type is not rendered), `buffer <hex>` (two lowercase
 *   hex digits per byte, no separators; empty for an empty buffer), `struct
 *   <fieldCount> <value>...` (the field count in hex followed by one value
 *   token per field slot, in slot order), `list <count> <value>...` (the
 *   element count in hex followed by one value token per element, in order;
 *   empty for an empty list), or `opaque`. Every other value kind renders as
 *   `opaque`, as does a value whose contents the renderer cannot reach: a
 *   native-backed struct, or a heap-allocated value with no heap bound.
 *   Rendering a value never fails.
 *
 * Line layout: a three-line header, then events in emission order.
 *
 * ```
 * mctrace 1
 * profile <profileId>
 * precision f32|f64
 * tick <ordinal> time <bits> dt <bits>
 * action <actionId> site <callSiteId> args <argc> <value>... result <value>
 * action <actionId> site <callSiteId> args <argc> <value>... async
 * tile <actionSlot> site <callSiteId> args <argc> <value>... result <value>
 * tile <actionSlot> site <callSiteId> args <argc> <value>... async
 * fault <fiberId> <errorCode>
 * ```
 *
 * - `tick`: one scheduled think, emitted before any event of that think.
 *   `<ordinal>` is 1-based. `time` and `dt` are the schedule-driven stamps
 *   the VM observes on its execution context: `time` is the cumulative
 *   scheduled time, and `dt` is 0 when the previous think time is 0 and the
 *   difference from the previous think time otherwise. Schedule times must
 *   be exactly representable at the profile precision.
 * - `action ... result`: one synchronous host-bound action dispatch, emitted
 *   when the call returns. `<actionId>` is the stable registry id,
 *   `<callSiteId>` keys the per-callsite host state, the `<argc>` argument
 *   values are the positional arg buffer exactly as the binding receives it (a
 *   missing optional slot is `nil`), and `result` is the value the call pushes
 *   back.
 * - `action ... async`: one asynchronous host-bound action dispatch, emitted
 *   when the body is invoked. The leading tokens match the synchronous form;
 *   the trailing `async` marks a call that returns a pending handle and no
 *   value.
 * - `tile ... result`: one synchronous bytecode-bound action dispatch -- a
 *   compiled tile -- emitted when its body hands control back.
 *   `<actionSlot>` is the action's index in the program's action table, in the
 *   same hex form as `<actionId>` and in a separate numbering space from it.
 *   The `<argc>` argument values are the body's parameter slots as it left
 *   them, and `result` is the value it returned. The lines of any action the
 *   body dispatched precede it.
 * - `tile ... async`: one asynchronous bytecode-bound action dispatch, emitted
 *   when the child fiber running the body is spawned. The `<argc>` argument
 *   values are the ones the dispatch passed; the trailing `async` marks a call
 *   that returns a pending handle and no value.
 * - `fault`: one fiber fault. `<errorCode>` is the numeric wire-stable
 *   `ErrorCode`. Fault messages are implementation-defined and never render.
 */

import { NativeType, type ReadonlyList, type Value } from "@wendoo/core/app";
import { bufferToHex, type NumberPrecision, type VmEvents } from "@wendoo/core/runtime";

/** Current observable trace format version. */
export const OBSERVABLE_TRACE_FORMAT_VERSION = 1;

/** Construction options for {@link ObservableTraceWriter}. */
export interface ObservableTraceOptions {
  /** Numeric device-profile id of the traced program's binary envelope. */
  readonly profileId: number;

  /** Profile numeric precision; selects the numeric bit-pattern width. */
  readonly precision: NumberPrecision;
}

/** Value token standing in for a value kind the trace format does not render. */
const OPAQUE_VALUE_TOKEN = "opaque";

function hexU32(value: number): string {
  return (value >>> 0).toString(16);
}

function hexPadded(value: number, width: number): string {
  return (value >>> 0).toString(16).padStart(width, "0");
}

function numberBits(value: number, precision: NumberPrecision): string {
  if (precision === "f32") {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value);
    return hexPadded(view.getUint32(0), 8);
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return hexPadded(view.getUint32(0), 8) + hexPadded(view.getUint32(4), 8);
}

function quoted(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = '"';
  for (const byte of bytes) {
    if (byte === 0x22) {
      out += '\\"';
    } else if (byte === 0x5c) {
      out += "\\\\";
    } else if (byte >= 0x20 && byte <= 0x7e) {
      out += String.fromCharCode(byte);
    } else {
      out += `\\x${hexPadded(byte, 2)}`;
    }
  }
  return `${out}"`;
}

function valueToken(value: Value, precision: NumberPrecision): string {
  switch (value.t) {
    case NativeType.Void:
      return "void";
    case NativeType.Nil:
      return "nil";
    case NativeType.Boolean:
      return `bool ${value.v ? "1" : "0"}`;
    case NativeType.Number:
      return `number ${numberBits(value.v, precision)}`;
    case NativeType.String:
      return `string ${quoted(value.v)}`;
    case NativeType.Enum:
      return `enum ${quoted(value.v)}`;
    case NativeType.Buffer:
      return `buffer ${bufferToHex(value)}`;
    case NativeType.Struct: {
      const fields = value.v;
      if (fields === undefined) {
        return OPAQUE_VALUE_TOKEN;
      }
      let text = `struct ${hexU32(fields.size())}`;
      for (let i = 0; i < fields.size(); i++) {
        text += ` ${valueToken(fields.get(i), precision)}`;
      }
      return text;
    }
    case NativeType.List: {
      const items = value.v;
      let text = `list ${hexU32(items.size())}`;
      for (let i = 0; i < items.size(); i++) {
        text += ` ${valueToken(items.get(i), precision)}`;
      }
      return text;
    }
    default:
      return OPAQUE_VALUE_TOKEN;
  }
}

/**
 * Accumulates observable-trace events and renders the canonical trace text.
 * The rendering is deterministic: equal event sequences produce byte-identical
 * traces. Construction emits the three-line header; each event method appends
 * one line.
 */
export class ObservableTraceWriter {
  private readonly precision: NumberPrecision;
  private out: string;

  constructor(options: ObservableTraceOptions) {
    this.precision = options.precision;
    this.out =
      `mctrace ${hexU32(OBSERVABLE_TRACE_FORMAT_VERSION)}\n` +
      `profile ${hexU32(options.profileId)}\n` +
      `precision ${options.precision}\n`;
  }

  /**
   * Records one scheduled think boundary.
   *
   * @param ordinal - 1-based tick ordinal within the schedule.
   * @param time - Cumulative scheduled time stamped on the execution context.
   * @param dt - Time delta stamped on the execution context.
   */
  tick(ordinal: number, time: number, dt: number): void {
    this.line(`tick ${hexU32(ordinal)} time ${numberBits(time, this.precision)} dt ${numberBits(dt, this.precision)}`);
  }

  /**
   * Records one completed synchronous host-bound action dispatch.
   *
   * @param actionId - Stable registry id of the dispatched action.
   * @param callSiteId - Call-site id the dispatch was bound to.
   * @param args - Positional arg buffer as received by the binding.
   * @param result - Value the call returned.
   */
  hostActionCall(actionId: number, callSiteId: number, args: ReadonlyList<Value>, result: Value): void {
    this.line(`${this.callPrefix("action", actionId, callSiteId, args)} result ${valueToken(result, this.precision)}`);
  }

  /**
   * Records one asynchronous host-bound action dispatch.
   *
   * @param actionId - Stable registry id of the dispatched action.
   * @param callSiteId - Call-site id the dispatch was bound to.
   * @param args - Positional arg buffer as received by the binding.
   */
  hostActionCallAsync(actionId: number, callSiteId: number, args: ReadonlyList<Value>): void {
    this.line(`${this.callPrefix("action", actionId, callSiteId, args)} async`);
  }

  /**
   * Records one completed synchronous bytecode-bound action dispatch.
   *
   * @param actionSlot - Index of the action in the program's action table.
   * @param callSiteId - Call-site id the dispatch was bound to.
   * @param args - The body's parameter slots as it left them.
   * @param result - Value the body returned.
   */
  bytecodeActionCall(actionSlot: number, callSiteId: number, args: ReadonlyList<Value>, result: Value): void {
    this.line(`${this.callPrefix("tile", actionSlot, callSiteId, args)} result ${valueToken(result, this.precision)}`);
  }

  /**
   * Records one asynchronous bytecode-bound action dispatch.
   *
   * @param actionSlot - Index of the action in the program's action table.
   * @param callSiteId - Call-site id the dispatch was bound to.
   * @param args - Positional arg buffer the dispatch passed.
   */
  bytecodeActionCallAsync(actionSlot: number, callSiteId: number, args: ReadonlyList<Value>): void {
    this.line(`${this.callPrefix("tile", actionSlot, callSiteId, args)} async`);
  }

  /**
   * Records one fiber fault.
   *
   * @param fiberId - Id of the faulted fiber.
   * @param code - Numeric wire-stable `ErrorCode` of the fault.
   */
  fiberFault(fiberId: number, code: number): void {
    this.line(`fault ${hexU32(fiberId)} ${hexU32(code)}`);
  }

  /** Returns the accumulated canonical trace text. */
  render(): string {
    return this.out;
  }

  private callPrefix(verb: string, id: number, callSiteId: number, args: ReadonlyList<Value>): string {
    let text = `${verb} ${hexU32(id)} site ${hexU32(callSiteId)} args ${hexU32(args.size())}`;
    for (let i = 0; i < args.size(); i++) {
      text += ` ${valueToken(args.get(i), this.precision)}`;
    }
    return text;
  }

  private line(text: string): void {
    this.out += `${text}\n`;
  }
}

/**
 * Builds the runtime event hooks that record a run's action dispatches and
 * fiber faults into `writer`. Pass the result as the `vmEvents` of the
 * `BrainRuntime` under trace.
 *
 * @param writer - Trace writer the observed events are appended to.
 */
export function observableTraceVmEvents(writer: ObservableTraceWriter): VmEvents {
  return {
    onFiberFault: (payload) => {
      writer.fiberFault(payload.fiberId, payload.err.code);
    },
    onHostActionReturn: (payload) => {
      if (payload.binding === "bytecode") {
        if (payload.result === undefined) {
          writer.bytecodeActionCallAsync(payload.actionId, payload.callSiteId, payload.args);
          return;
        }
        writer.bytecodeActionCall(payload.actionId, payload.callSiteId, payload.args, payload.result);
        return;
      }
      if (payload.result === undefined) {
        writer.hostActionCallAsync(payload.actionId, payload.callSiteId, payload.args);
        return;
      }
      writer.hostActionCall(payload.actionId, payload.callSiteId, payload.args, payload.result);
    },
  };
}
