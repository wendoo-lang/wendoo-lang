# Observable-Trace Contract (core)

The observable trace is a deterministic, line-oriented, ASCII record of one VM
run's externally visible effects under a scripted input schedule. Two VM
implementations fed the same program and the same schedule produce
byte-identical traces, so the trace committed beside a corpus program is the
behavioral contract a separately built VM is verified against.

This file covers the CORE half of the grammar: the line kinds any VM emits from
the shared runtime event seam and the replayed schedule. The reference renderer
is `packages/conformance/src/trace.ts`, which is where the grammar is defined
and versioned (`OBSERVABLE_TRACE_FORMAT_VERSION`); when this spec and that
module disagree, this spec is wrong and is fixed in the same change.

A target extends the core grammar with its own line kinds and versions those
separately. The micro:bit extensions (`port`, and the target specifics of
`tile`) are documented in wendoo-mcu's
`docs/specs/contracts/observable-trace.md`.

This is not the bytecode contract: it does not change `vm-contract.md`.

## Lexical rules

- The trace is ASCII with LF line endings and ends with a trailing LF. Tokens on
  a line are separated by single spaces; lines are not indented.
- Integer scalars -- tick ordinals, action ids, call-site ids, argument counts,
  fiber ids, fault codes -- render as the minimal lowercase hexadecimal of their
  unsigned 32-bit value, with no prefix and no padding (`0` for zero).
- Brain-observable numbers -- tick time/dt stamps, number-typed action arguments
  and results -- render as the IEEE-754 bit pattern of the value at the trace's
  profile precision: 8 zero-padded lowercase hex digits of the f32 bits on an
  f32 profile, 16 digits of the f64 bits on an f64 profile. Numbers never render
  as decimal.
- Strings render as a double-quoted UTF-8 byte sequence: bytes `0x20..0x7e` are
  literal except `"` (renders `\"`) and `\` (renders `\\`); every other byte
  renders as `\xNN` with two lowercase hex digits.

## Value tokens

A value token is one of:

| Token | Meaning |
|-------|---------|
| `void` | The void singleton. |
| `nil` | The nil singleton, including a missing optional argument slot. |
| `bool 0` / `bool 1` | A boolean. |
| `number <bits>` | A number, as the bit pattern above. |
| `string "<bytes>"` | A string, quoted as above. |
| `enum "<symbol>"` | An enum symbol's name, quoted as a string. The enum's type is not rendered. |
| `buffer <hex>` | A buffer: two lowercase hex digits per byte, no separators; empty for an empty buffer. |
| `struct <fieldCount> <value>...` | A struct: the field count in hex, then one value token per field slot, in slot order. |
| `list <count> <value>...` | A list: the element count in hex, then one value token per element, in order; empty for an empty list. |
| `opaque` | Every other value kind, and any value whose contents the renderer cannot reach (a native-backed struct, or a heap-allocated value with no heap bound). |

Rendering a value never fails.

## Layout

A three-line header, then the events in emission order:

```
mctrace 1
profile <profileId>
precision f32|f64
tick <ordinal> time <bits> dt <bits>
action <actionId> site <callSiteId> args <argc> <value>... result <value>
action <actionId> site <callSiteId> args <argc> <value>... async
tile <actionSlot> site <callSiteId> args <argc> <value>... result <value>
tile <actionSlot> site <callSiteId> args <argc> <value>... async
fault <fiberId> <errorCode>
```

### Header

- `mctrace <version>` -- the trace format version, in hex.
- `profile <profileId>` -- the numeric device-profile id of the traced program's
  binary envelope.
- `precision f32|f64` -- the profile's numeric precision, which selects the width
  of every number bit pattern in the body.

### Core line kinds

- `tick` -- one scheduled think, emitted before any event of that think.
  `<ordinal>` is 1-based. `time` and `dt` are the schedule-driven stamps the VM
  observes on its execution context: `time` is the cumulative scheduled time,
  and `dt` is 0 when the previous think time is 0 and the difference from the
  previous think time otherwise. Schedule times must be exactly representable at
  the profile precision.
- `action ... result` -- one synchronous host-bound action dispatch, emitted when
  the call returns. `<actionId>` is the stable registry id, `<callSiteId>` keys
  the per-callsite host state, the `<argc>` argument values are the positional
  arg buffer exactly as the binding receives it (a missing optional slot is
  `nil`), and `result` is the value the call pushes back. A body that faults
  emits no line.
- `action ... async` -- one asynchronous host-bound action dispatch, emitted when
  the body is invoked. The leading tokens match the synchronous form; the
  trailing `async` marks a call that returns a pending handle and no value. The
  later settlement of that handle is not itself a line.
- `tile ... result` -- one synchronous bytecode-bound action dispatch -- a
  compiled tile -- emitted when its body hands control back. `<actionSlot>` is
  the action's index in the program's action table, in the same hex form as
  `<actionId>` and in a numbering space separate from it. The `<argc>` argument
  values are the body's parameter slots as it left them, and `result` is the
  value it returned. The lines of any action the body dispatched precede it. A
  body that faults emits no line.
- `tile ... async` -- one asynchronous bytecode-bound action dispatch, emitted
  when the child fiber running the body is spawned. The `<argc>` argument values
  are the ones the dispatch passed; the trailing `async` marks a call that
  returns a pending handle and no value.
- `fault` -- one fiber fault. `<errorCode>` is the numeric wire-stable
  `ErrorCode`. Fault messages are implementation-defined and never render.

## Versioning

`OBSERVABLE_TRACE_FORMAT_VERSION` in `packages/conformance/src/trace.ts` is the
single version of the core grammar, and it is the number the `mctrace` header
line carries. Version 1 is LOCKED: any change to a lexical rule, a value token,
a header line, or a core line kind bumps the version and regenerates every
committed trace. Adding a value-token kind for a value that previously rendered
`opaque` is such a change.

A target's own line kinds are versioned by that target, independently of this
number.
