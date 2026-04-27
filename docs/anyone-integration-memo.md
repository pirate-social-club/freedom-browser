# Freedom x Anyone Integration Memo

## Scope

Integrate Anyone as an app-level SOCKS transport in Freedom's main process without changing package boundaries.

Why this location fits:
- Freedom already owns transport lifecycle in `src/main/`.
- `network-manager.js` already composes HNS and Sentinel through a PAC layer.
- `service-registry.js` is already the canonical cross-window transport status surface.

Why alternatives were not used:
- Extending the existing main-process transport pattern keeps PAC and lifecycle ownership in one place instead of introducing a second transport layer in the renderer.

## anyone-manager.js Interface

Modeled on `dvpn-manager.js`, but simpler:

- `registerAnyoneIpc()`
- `initAnyone()`
- `startAnyone()`
- `stopAnyone()`
- `getStatus()`

State machine:

- `OFF`
- `STARTING`
- `CONNECTED`
- `STOPPING`
- `ERROR`

Operational rules:

1. Use the real SDK API: `Process`, `Control`, `Socks`.
2. Trust `Process.start()` as the "network ready" signal.
3. Manage `terms-agreement` explicitly under `app.getPath('userData')/anyone/terms-agreement`.
4. If Freedom later uses explicit `configFile`, it must also manage `DataDirectory` and the agreement file inside it.
5. Call `Process.killAnonProcess()` before every start.
6. Call `Process.killAnonProcess()` on every failure path and every stop path.

Data layout:

- `userData/anyone/terms-agreement`
- `userData/anyone/state.json`

Persistence:

- Persist last Anyone state for crash recovery diagnostics.
- `initAnyone()` always performs stale-process cleanup before restoring `OFF`.

## PAC Chain Design

`network-manager.js` should move from a single SOCKS slot to an ordered transport chain.

Default implementation in this branch:

- Anyone first
- Sentinel second
- `DIRECT` last

PAC output with Anyone first:

```pac
return "SOCKS5 127.0.0.1:9050; SOCKS 127.0.0.1:9050; SOCKS5 127.0.0.1:10808; SOCKS 127.0.0.1:10808; DIRECT";
```

Alternative PAC output with Sentinel first:

```pac
return "SOCKS5 127.0.0.1:10808; SOCKS 127.0.0.1:10808; SOCKS5 127.0.0.1:9050; SOCKS 127.0.0.1:9050; DIRECT";
```

Recommendation:

- Default to Anyone first because it is free and lower-friction.
- Keep ordering internal for now; if product needs user choice later, expose a transport-priority setting on top of the same chain model.

HNS remains higher priority than both transports.
Loopback remains `DIRECT`.

## IPC / Settings Surface

IPC:

- `ANYONE_START`
- `ANYONE_STOP`
- `ANYONE_GET_STATUS`
- `ANYONE_STATUS_UPDATE`

Settings:

- `enableAnyone`
- `anyoneAutoStart`

No wallet, balance, QR, or payment controls are part of Anyone.

## service-registry.js Shape

Add an `anyone` entry alongside `dvpn`:

- `proxy`
- `connected`
- `socksPort`
- `controlPort`
- `circuitState`
- `error`

`service-registry` remains the renderer-facing aggregate status surface; `anyone-manager` remains the lifecycle owner.

## Invariants

The manager must uphold these invariants at all times:

1. `Process.start()` is the only success signal for switching PAC to Anyone.
2. `terms-agreement` exists before every Anyone start.
3. No start occurs without first killing stale `anon` processes.
4. No stop returns success unless PAC has been rebuilt without Anyone.
5. Timeout and bridge-failure paths kill stale `anon` before returning.
6. After cleanup, Freedom can immediately fall back to a normal direct Anyone session with no cooldown.
