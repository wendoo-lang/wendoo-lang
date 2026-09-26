---
title: Session management
status: Accepted
# Active status:   Draft -> Review -> Accepted -> Committed -> In-Progress -> Shipped
# Terminal status: Rejected | Withdrawn | Superseded (set superseded-by)
created: 2026-09-25
updated: 2026-09-25
---

# Session Management

The standing description of the Wendoo bridge session system and the
contract by which applications slot into it. This document is the
design's authoritative voice, written in present tense; workstream
history lives with the workstreams. Where a piece is scheduled for
re-derivation, this document states the current rule and marks it,
and is updated to plain statements as pieces settle. The mechanism
is lane-agnostic; each integration documents its concrete role
assignments in its own repository.

## The ontology

A SESSION is the logical binding between two application endpoints --
typically an editing environment bound to a host environment. It is
embodied server-side as a relay pairing and durably identified
by a binding id, presented to clients as a binding token.

CONNECTED / DISCONNECTED is a STATUS on the session. Status gates what
is possible on the session; it never drives the session's lifecycle.
For editors specifically: status gates DELIVERY (sync, writes,
catalog freshness), never AUTHORING -- editing continues while
disconnected, with changes pending locally and the status clearly
indicated.

Session LIFECYCLE events are exactly three: formation, replacement,
and end (explicit, or by sweep after a fully-disconnected linger).
A member dropping and returning is a status transition of the same
session. Wire-level handshake machinery -- sockets, hellos, welcomes
-- is connection-scoped plumbing the session absorbs; no connectivity
event creates or destroys a session.

## Identity and credentials

- The BINDING TOKEN is the durable credential, and the only one an
  endpoint holds once its session is established: it identifies the
  session across disconnects and reclaims it during linger. A token
  naming a session that replacement ended never reaches the
  successor: it fails silently, and its holder reaches the successor
  only by a person entering a join code.
- BINDINGS SURVIVE SERVICE RESTARTS. A token carries no expiry and
  verifies for as long as the service's signing secret is unchanged.
  A hello presenting a verified token whose binding no live session
  holds -- after a restart, or after a sweep -- re-forms the session
  under that binding, with a fresh session id and a fresh join code;
  the counterpart's token binds into it, both members are welcomed,
  and each welcome carries a token identical to the one presented.
  No one enters a code. Session ids and join codes re-mint at every
  restart; the displays follow the pushed code. A service without a
  durable secret verifies no token issued before its restart, and so
  ends its sessions at restart.
- The JOIN CODE is the ephemeral entry credential: how a person
  connects the two sides. Join codes are generated as word triplets
  (one shared generator serves every relay) and ROTATE
  unconditionally on a fixed interval -- rotation is engine behavior
  with no configuration surface.
- A code is presented only until acceptance. An endpoint's hellos
  carry a join code only until one of them is accepted (welcomed):
  the code a person entered, or none from the endpoint whose first
  hello asks the relay to mint the session's code. Acceptance spends
  the code; every later hello, reconnects included, presents the
  token alone. A code the relay sends -- answering a hello, pushed at
  rotation, or carried in a welcome -- feeds the endpoint's display
  and is never presented.
- A presented code therefore always expresses current human intent,
  so a hello presenting both a join code and a token is matched by
  the code first and by the token only when the code matches
  nothing. Rotation never strands an established endpoint, which
  holds no code to go stale.
- SESSION IDS are engine bookkeeping. They change at replacement.
  Nothing user-facing keys continuity on a session id; product
  continuity is anchored on the token.

## Lifecycle in wire terms

FORMATION. Each party connects to its role endpoint and sends
`session:hello` declaring the protocol version it speaks. A valid
hello is answered immediately with `session:joinCode`. The
`session:welcome` is deferred until BOTH roles of the pairing are
bound; it means "your session is connected", never "the relay heard
you". Version rejection is immediate: `session:error` with a stable
code, then the socket closes.

STATUS. When a member drops, the session becomes disconnected for
that side and the remaining member receives `session:counterpartAway`
-- a payload-less status signal, cleared by the next welcome. The
session lingers (retaining id, code, and binding identity) and is
reclaimed by a returning member's token; the stable peer is then
RE-WELCOMED. Every welcome, first or repeated, instructs an endpoint
to refresh its connection-scoped handshake machinery; the session
itself persists across welcomes.

ENDING. A new claimant on an occupied role (no matching token) is
REPLACEMENT: the one session-ending event besides explicit end and
sweep. The session ends and a successor with fresh identity -- a new
session id and binding -- takes its place under the join code the
claimant presented. Only the displaced member's connection closes.
The other role's member, when connected, is MIGRATED: re-bound into
the successor in place, on its open connection, and re-welcomed with
the successor's session id and a fresh binding token, alongside the
claimant's own welcome. A member absent at the replacement holds a
token naming the ended session; it fails silently on return, and
that member rejoins by a person entering the join code. A session
with no members for longer than the linger window is swept.

SESSION_REPLACED is a client-hold signal, not a session-lifecycle
statement: it tells one connection "another connection of your role
has taken your place; do not reconnect automatically." It is sent in
exactly two cases -- to the displaced same-role member at
replacement (whose session ended), and to a member's superseded old
connection when that member re-binds (whose session continues under
the newcomer). It is never sent to the other role's member, which at
replacement is migrated instead.

## The version discipline

One version space per session kind. Each party declares the version
it speaks; a receiver accepts any declared version at or below its
own maximum and records it; only a NEWER declaration is rejected,
with a stable code and a human remedy. Deployment cadence orders the
parties -- from the most version-pinned (code embedded in end-user
projects) through intermediaries on their own release cadence to
evergreen applications -- and newer parties adapt down, never up.
Payload message kinds carry no versions of their own. A lane's
host-side emission channel, where one exists, carries the emitter's
declared version in its framing.

## The engine / application seam

THE ENGINE (`@wendoo/bridge-session`, upstream, platform-clean) owns
everything subtle and stateful about sessions:

- the session state machine: formation, status, linger, sweep,
  replacement, re-welcome;
- binding ids, token minting and verification, and re-forming a
  session from a verified token whose binding no live session holds;
- join-code generation (via `@wendoo/join-codes`), uniqueness, and
  rotation;
- rate protection (throttles, pending-request bookkeeping);
- the emission points for every session signal (joinCode, welcome,
  counterpartAway, coded errors);
- [stated at the engine extraction: the liveness definition that
  decides "disconnected", and whether the endpoint peer-session
  mechanism is part of the engine or a separate endpoint layer.]

The engine is kind-blind and platform-blind: it never learns what a
session kind means, what payloads contain, or which product it
serves. It calls outward through an adapter interface -- send, close,
on-pair, on-drop.

APPLICATIONS (the relay services) own:

- the route surface: generic `/{kind}/{role}` routes, or a fixed
  role pair;
- the FORWARDING POLICY, chosen once per service and part of its
  identity: OPAQUE forwarding (every non-control message passes
  byte-verbatim, unparsed -- payloads and whole session kinds evolve
  without redeploying the relay) or DOMAIN ROUTING (recognized
  message families dispatch through the service's own handlers);
- deployment identity: configuration, secrets, hardening, cadence.

Neither service contains session logic. Each is an adapter plus a
deployment.

## How applications slot in

A SESSION KIND is declared by a kind package. The kind package owns the kind's whole
identity: its name, its wire message types and their namespace, its
protocol version, its role-path segments, and the connect function
binding the endpoint mechanism to the kind. Kind packages live with
their platform integration, never in core packages -- core stays
greppably free of platform names. Kind names must not collide with
the reserved bridge namespaces, or their payloads are never
delivered.

ENDPOINTS reach the wire through the role-generic client
(`ProjectSession`, with its payload surface and session events) or
the app-role wrapper (`AppBridge`). An endpoint's obligations:

- open or refresh its connection-scoped handshake on EVERY welcome,
  keeping the binding token each one carries -- a migrating welcome
  carries a new one;
- treat `counterpartAway` and the welcome as the session status
  signals; never infer lifecycle from transport events;
- key nothing on session ids; anchor continuity on the token alone,
  present a join code only until acceptance, and treat every code
  the relay sends as display;
- surface the session to product code as ONE object with stable
  identity, a status field, and a first-class state-change event
  surface [the canonical consumer surface is settled with the first
  editor implementation].

EDITOR-CLASS applications additionally follow the offline rule:
authoring continues while disconnected, changes pend locally, the
disconnected status is clearly indicated, and pends flush on
reconnect.

## Standing constraints

- The relay is STATIONARY: payload evolution and new session kinds
  never require a relay deployment; only control-envelope changes do.
- Join-code uniqueness and pairing are per relay instance; the
  system is single-instance by design until a deployment slice rules
  otherwise.
- Trust never derives from session traffic: provenance and
  assistant-content gating ride host-attested channels and
  point-of-use allowlists, outside this system.
- Kid-facing resilience governs every surface here: mistakes are
  diagnosed with stable codes and the system soldiers on. The only
  hard stops are the version rejection, SESSION_REPLACED, and an
  endpoint discarding an outbound backlog that outgrew its bound
  while its connection was down; each carries a stable code and a
  remedy.
- Recovery is always in place: no failure leaves an endpoint needing
  an application reload to work again. Every terminal signal leaves
  the endpoint's client able to start again in place; the hold after
  SESSION_REPLACED forbids AUTOMATIC reconnection, not the recovery
  path itself. A member superseded by its own re-bind still holds a
  token for the live session, so starting again takes it back; a
  member displaced at replacement holds a token for the ended one,
  and its path back is a person entering the join code, in place.
  The one exception is the version rejection, whose remedy is
  updating the outdated party.

## Open re-derivations

Tracked in the owning workstreams: the two-handshake sequence and
possible vestigial peer-session machinery; the liveness owner (a
counterpart-away signal today fires only on a real transport close,
so its latency is unbounded for half-open drops until liveness has
an owner); the mapping of fixed-role-pair services onto {kind,
role}. Each resolves inside the engine-extraction or editor work,
and this document is updated to plain statements as they settle.
