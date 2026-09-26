---
applyTo: "packages/bridge-session/**"
---

# Bridge Session Engine

`@wendoo/bridge-session` is the session engine: the one
implementation of the session model both relay services run on.
The semantics -- ontology, credentials, lifecycle, liveness,
rotation, recovery -- are specified in
`docs/specs/session-management.md`; that document is
authoritative, and a change to what an endpoint observes is a
session-protocol change that updates the spec in the same unit.

## Platform-Blind, Kind-Blind

The engine never learns what a session kind means, what payloads
contain, or which product it serves. The package must stay
greppably free of platform names (makecode, arcade, vscode,
microbit, and the like) in source, configs, and fixtures; specs
use neutral kinds. Platform session kinds live with their
integrations, never here.

## The Adapter Seam

Services are adapters plus deployment identity. They hand
connections to `Relay.connect(kind, role, socket)` and receive a
`RelayConnection` handler; `RelaySocket`/`RelayConnection` are
the whole transport contract. A service may supply a
`frameHandler` (domain routing); absent one, forwarding is
opaque and byte-verbatim. Transport hardening (per-address
admission, HTTP-layer limits) belongs to services; per-connection
rate protection, liveness, and every session rule belong here.

## Constants, Not Knobs

Session timing (linger, rotation, entry grace, quarantine,
activity timeout, reply deadline) is engine constants. The
`RelayTimings` options exist for the test harness only; services
construct the engine with defaults and expose no configuration
surface for them.

## The Admin Surface

`sessions()`, `endSession(id)`, and `disconnectMember(id)` exist
for operator inspection (the vscode-bridge REPL is the consumer)
and are deliberately minimal. There is no command-registration
or inspection extensibility; additions wait for a real customer.

## Testing

`@wendoo/bridge-session/testing` is the real-engine test harness
(in-process server, scripted peers, signal assertions, timing
seams, injectable server starter). Consumers test against the
real engine through it -- never a hand-rolled relay model; the
unfaithful-fake episode is why. Services inject their own server
shells so their transport stays covered.
