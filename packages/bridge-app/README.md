# @wendoo/bridge-app

App-side client for the Wendoo bridge.

Wraps `@wendoo/bridge-client` with app-role-specific behavior: automatic join code
management and the `"app"` WebSocket path, or the path given as `wsPath`. Apps that connect to the bridge should depend on
this package rather than using `bridge-client` directly.

## Usage

```typescript
import { createAppBridge } from "@wendoo/bridge-app";
import { createCompilationFeature } from "@wendoo/bridge-app/compilation";

const bridge = createAppBridge({
  bridgeUrl: "localhost:6464",
  filesystem: myProjectFileSystem,
  features: [createCompilationFeature({ compiler })],
});

bridge.start();
```

`bridgeUrl` is a bare host with an optional port. The bridge connects with `ws://` to a
loopback host and `wss://` to any other.

The bridge facade supports:

- `start()` / `stop()` -- lifecycle management; after a failure ends the session, `start()`
  opens a new one
- `requestSync()` -- request a full project file sync from the VS Code extension
- `snapshot()` -- current connection status, join code, the stable code of the
  failure that ended the session, if one did, and `counterpartAway: true` while the
  bridge reports the session's counterpart disconnected
- `onStateChange(...)` / `onRemoteChange(...)` -- event subscriptions
- `sendPayload(...)` / `onPayload(...)` -- send and receive payload messages: messages
  whose type lies outside the bridge protocol's own namespaces, carried verbatim

Optional features (like compilation) attach through the `features` array and receive
a `AppBridgeFeatureContext` with project file access, sync hooks, and diagnostic/status
publication helpers.

## Install

```sh
npm install @wendoo/bridge-app
```

## License

MIT
