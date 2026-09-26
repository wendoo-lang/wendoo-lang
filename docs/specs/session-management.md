---
title: Session management
status: Accepted
# Active status:   Draft -> Review -> Accepted -> Committed -> In-Progress -> Shipped
# Terminal status: Rejected | Withdrawn | Superseded (set superseded-by)
created: 2026-09-25
updated: 2026-09-26
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

Session LIFECYCLE events are exactly two: formation, and end --
explicit, by a member or an operator, or by sweep after a
fully-disconnected linger. Either end ends the session; the binding
persists in the tokens its members hold and can re-form a session. A
member dropping and returning is a status transition of the same
session. Wire-level handshake machinery -- sockets, hellos, welcomes
-- is connection-scoped plumbing the session absorbs; no connectivity
event creates or destroys a session.

## Identity and credentials

- The BINDING TOKEN is the durable credential, and the only one an
  endpoint holds once its session is established: it identifies the
  session across disconnects and reclaims it during linger.
- BINDINGS SURVIVE SERVICE RESTARTS. A token carries no expiry and
  verifies for as long as the service's signing secret is unchanged.
  A hello presenting a verified token whose binding no live session
  holds -- after a restart, a sweep, or an explicit end -- re-forms
  the session under that binding, with a fresh session id and a fresh
  join code; the counterpart's token binds into it, both members are
  welcomed, and each welcome carries a token identical to the one
  presented. No one enters a code. Session ids and join codes re-mint
  at every restart; the displays follow the pushed code. A service
  without a durable secret verifies no token issued before its
  restart, and so ends its sessions at restart.
- The JOIN CODE is the ephemeral entry credential: how a person
  connects the two sides. Join codes are generated as word triplets
  (one shared generator serves every relay), and no code in service
  joins two sessions of a kind. Minting draws a bounded number of
  triplets; should every draw be taken, it appends a random suffix
  to a triplet rather than draw again.
- A join code EXISTS EXACTLY WHILE ITS SESSION HAS A VACANT ROLE. The
  relay mints one when a session forms (its first member awaiting the
  second) and again each time a member's connection closes, and sends
  it to each connected member as `session:joinCode`; the code leaves
  service the moment both roles are bound, and when the session ends.
  Every minted code is new: never one in service, never one in
  quarantine. A session whose roles are both bound holds no code, so
  no code in service ever targets an occupied role. The code belongs
  to the session's vacancy, not to a member: the relay sends it to
  whichever members are connected, whatever their role, and which side
  displays a code and which side enters one is each lane's to decide.
- Join codes ROTATE unconditionally: rotation is engine behavior
  with no configuration surface. Every ten minutes, every code in
  service -- a waiting or lingering session's -- is replaced by a
  newly minted one, which each connected member receives as
  `session:joinCode`. For two minutes after a rotation (or until the
  next rotation, if that comes first) a hello presenting a session's
  previous code still joins it, so a person partway through typing a
  code is never stranded by a rotation; answers and welcomes always
  carry the current code.
- A code that leaves service -- replaced by rotation once its grace
  ends, taken out of service when both roles bind or a member drops,
  or held by a session that ends -- is QUARANTINED: it is not minted
  again for the linger window (five minutes), so a person typing a
  code that has just gone stale cannot land in a stranger's freshly
  minted session.
- A code is presented only until acceptance. An endpoint's hellos
  carry a join code only until one of them is accepted (welcomed):
  the code a person entered, or none from the endpoint whose first
  hello asks the relay to mint the session's code. Acceptance spends
  the code; every later hello, reconnects included, presents the
  token alone. A code the relay sends answering a hello, or pushed
  when a role falls vacant or at rotation, feeds the endpoint's
  display; the code a welcome carries has already left service and is
  displayed nowhere, and a welcome takes any displayed code down. No
  code the relay sends is ever presented.
- A presented code therefore always expresses current human intent,
  and a hello presenting one is matched by the code alone. A code in
  service joins its session's vacant role. A code that opens no vacant
  role -- no session of the kind holds it, or its session has the
  hello's role bound -- is REFUSED: the relay answers the hello with
  `session:error` carrying `JOIN_CODE_UNKNOWN` and closes the
  connection, and the endpoint holds without reconnecting until a
  person enters a current code, in place. (A hello presenting, with
  the code, the token of the member holding its role is that member's
  own supersession; see ENDING.) A hello presenting no code is matched
  by its token, and a hello presenting neither forms a new session.
  Rotation never strands an established endpoint, which holds no code
  to go stale.
- SESSION IDS are engine bookkeeping: welcomes carry them, hellos
  never present them, and a session re-formed from a token gets a new
  one. Nothing user-facing keys continuity on a session id; product
  continuity is anchored on the token.

## Lifecycle in wire terms

FORMATION. Each party connects to its role endpoint and sends
`session:hello` declaring the protocol version it speaks. A valid
hello is answered immediately with `session:joinCode`, carrying the
session's most recent code. The `session:welcome` is deferred until
BOTH roles of the pairing are bound; it means "your session is
connected", never "the relay heard you". Its join code is the one
that just left service as the second role bound; it joins nothing,
and no endpoint displays it.
Version rejection is immediate: `session:error` with a stable code,
then the socket closes.

STATUS. When a member drops, the session becomes disconnected for
that side and the remaining member receives `session:counterpartAway`
-- a payload-less status signal, cleared by the next welcome -- and
then `session:joinCode` carrying the code minted for the vacant role.
The session lingers (retaining its id and binding identity, its code
rotating as every code in service does) and is reclaimed by a
returning member's token, or joined by a person entering its current
code; the stable peer is then RE-WELCOMED. Every welcome, first or
repeated, instructs an endpoint to refresh its connection-scoped
handshake machinery; the session itself persists across welcomes.

LIVENESS is the engine's. A connection that sends nothing for one
minute is closed by the relay, and its member has dropped exactly as
on any closed connection. Endpoints send `control:ping` every fifteen
seconds, which the relay answers with `control:pong`, so a live
endpoint never trips the timeout; a half-open connection -- one whose
far end is gone without a close -- is detected within about a minute,
which bounds how long its role stays held and how late its
counterpart learns it is away.

ENDING. A session ends in exactly two ways. EXPLICIT END: a member
sends `session:goodbye`, or an operator ends the session. The relay
ends the session at once -- its codes leave service and its pairing
is gone -- and closes both members' connections, first sending each
member that did not ask for the end a `session:error` carrying
`SESSION_ENDED` (an operator end tells both). SWEEP: a session with
no members for longer than the linger window ends. An end is final
for the session, not for the binding: a later, deliberate connect
presenting a member's token re-forms a session under it (see
Identity and credentials).

There is no replacement. Because a session whose roles are bound holds
no code, no hello claims an occupied role by code. The one takeover is
SUPERSESSION: a hello presenting a member's own token while an older
connection of that member still holds the role takes the role over.
The older connection receives `session:error` carrying
`SESSION_REPLACED` and closes; the session continues under the newer
connection, and a connected counterpart is re-welcomed.

SESSION_REPLACED and SESSION_ENDED are client-hold signals: each tells
one connection "do not reconnect automatically". SESSION_REPLACED is
sent in exactly one case, to a member's older connection when that
member re-binds by its token, and never to the other role's member.
SESSION_ENDED is sent only by an explicit end, to the members that did
not ask for it.

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

## The two-layer handshake

Two handshakes stack, and each answers one question.

The RELAY layer answers "is the session connected?": `session:hello`,
answered by `session:joinCode`, then `session:welcome` once both roles
are bound, repeated whenever a member binds back in. It is spoken
between each endpoint and the relay, and the engine owns it.

The KIND layer answers "do the two endpoints speak a common version
of their kind?". On every welcome, each endpoint opens a fresh peer
session over the payload channel: each sends `<kind>:hello` declaring
the version it speaks, and sends nothing else of the kind until it has
received the peer's hello; each adapts down, refusing only a newer
version. Because welcomes gate the kind layer, both kind hellos travel
over a connected session and neither is lost. A peer session covers
one connection of the peer: a message arriving before the peer's hello
belongs to the peer's previous session and is dropped, and a message
arriving after the peer's hello but before the endpoint subscribes is
held for its first subscriber. The kind layer is endpoint mechanism
(the peer-session mechanism of the app-role package), not engine: the
relay forwards its messages as payloads and never reads them.

## The engine / application seam

THE ENGINE (`@wendoo/bridge-session`, upstream, platform-clean) owns
everything subtle and stateful about sessions:

- the session state machine: formation, status, linger, sweep,
  explicit end, supersession, re-welcome;
- binding ids, token minting and verification, and re-forming a
  session from a verified token whose binding no live session holds;
- join codes: generation (via `@wendoo/join-codes`), uniqueness, the
  vacancy-only lifecycle, the refusal of a code that opens no vacant
  role, rotation with its entry grace, and the quarantine of retired
  codes;
- liveness: each connection's activity timeout, which closes a silent
  connection into the normal drop path;
- rate protection: each connection's message allowance, a burst and
  then a steady rate, beyond which a message is answered with an
  `error` message and dropped;
- request bookkeeping: the correlation that returns a reply -- a
  message carrying the `id` of one the engine forwarded, within a
  thirty-second reply deadline -- to the connection whose message it
  answers, byte-verbatim; after the deadline a message carrying that
  `id` is an ordinary one;
- the emission points for every session signal (joinCode, welcome,
  counterpartAway, coded errors);
- operator inspection and administration: a read-only snapshot of
  every session (its kind, session id, its join code while a role is
  vacant, and each role connected or lingering, with the connected
  member's id and when the role entered its state), ending a session
  by id at once, telling each member `SESSION_ENDED`, and
  disconnecting a member by id, which then returns by its token like
  any dropped member. An application may expose these on an operator
  console.

The engine is kind-blind and platform-blind: it never learns what a
session kind means, what payloads contain, or which product it
serves. It is the package `@wendoo/bridge-session`, whose `Relay`
meets its transport through a two-sided adapter interface. An
application registers each connection it opens with
`connect(kind, role, socket)`, handing the engine a socket with two
operations -- `send` one text frame, and `close` the connection --
and reports that connection's events back through the handler
`connect` returns: `receive` for each text frame, and `closed` once
the connection has closed. Every session signal leaves the engine
through `send`; the engine closes connections only through `close`.
An application may also hand the engine a FRAME HANDLER, which
settles every message outside the control namespaces that is not a
reply: it forwards the message to the sender's peer, as received or
rewritten, replies to the sender, or drops it. A message the handler
forwards carrying an `id` has its peer's reply correlated back like
any forwarded message's, without passing through the handler.
Without a frame handler the engine forwards every such message
byte-verbatim.

APPLICATIONS (the relay services) own:

- the route surface: generic `/{kind}/{role}` routes, or a fixed
  pair of role routes mapped onto a single kind;
- the FORWARDING POLICY, chosen once per service and part of its
  identity: OPAQUE forwarding (every non-control message passes
  byte-verbatim, unparsed -- payloads and whole session kinds evolve
  without redeploying the relay) or DOMAIN ROUTING (recognized
  message families dispatch through the service's own handlers). A
  domain-routing service supplies its policy as the engine's frame
  handler; an opaque one supplies none;
- deployment identity: configuration, secrets, hardening at the
  transport (such as per-address admission limits), cadence.

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
the app-role wrapper (`AppBridge`, which reports every welcome it
accepts as a first-class welcome event and ends a session on purpose
with `end()`). An endpoint's obligations:

- open or refresh its connection-scoped handshake on EVERY welcome,
  keeping the binding token each one carries;
- treat `counterpartAway` and the welcome as the session status
  signals; never infer lifecycle from transport events;
- key nothing on session ids; anchor continuity on the token alone,
  present a join code only until acceptance, and treat every code
  the relay sends as display;
- keep its connection active with `control:ping`, and close it --
  never end the session -- when it goes away for a reload or a
  restart; end the session with `session:goodbye` only on purpose;
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
  hard stops are the version rejection, `JOIN_CODE_UNKNOWN`,
  `SESSION_REPLACED`, `SESSION_ENDED`, and an endpoint discarding an
  outbound backlog that outgrew its bound while its connection was
  down; each carries a stable code and a remedy.
- Recovery is always in place: no failure leaves an endpoint needing
  an application reload to work again. Every terminal signal leaves
  the endpoint's client able to start again in place; a hold forbids
  AUTOMATIC reconnection, not the recovery path itself. A member
  superseded by its own re-bind still holds a token for the live
  session, so starting again takes it back; an endpoint refused for
  its code enters a current one; an endpoint told its session ended
  connects again deliberately, by its token (re-forming the session)
  or by a code. The one exception is the version rejection, whose
  remedy is updating the outdated party.

## Open re-derivations

Tracked in the owning workstreams: the canonical consumer surface
(marked above). It resolves inside the editor work, and this document
is updated to plain statements as it settles.
