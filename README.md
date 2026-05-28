# RTI Driver Test Harness

Integration-test framework for RTI XP Processor drivers. It loads a compiled driver bundle into a Node.js VM, replaces the proprietary RTI Script runtime with software fakes, and lets you assert on System Variable writes driven by live external devices.

## How it works

An RTI XP driver is a compiled JavaScript bundle that expects the RTI Script runtime globals — `System`, `Config`, `SystemVars`, `SystemVarsList`, `Timer`, `TCP`, `Persistence` — to be injected by the processor firmware. The harness provides fakes for all of those globals and executes the driver with `vm.runInThisContext`, placing all driver-exported functions and variables into the Node.js global scope exactly as the XP Script engine does on hardware. Because `TCP` uses real sockets, the driver connects to actual controlled devices over the network exactly as it would on a physical XP processor.

Tests assert on `SystemVars.Write` calls via a time-bounded monitor, simulate RTI panel actions (scrolling Item Lists, calling System Functions) through `VirtualRemote` handles, and manage companion processes through spawn/shell hooks.

## Installation

```bash
npm install --save-dev github:RTI-Developers/test-harness
```

Add a `vitest.config.ts` (or extend your existing one) with generous timeouts — integration tests talk to real network devices:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        testTimeout: 120_000,
        hookTimeout:  30_000,
    },
});
```

## Quick start

```ts
import { describe, it, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { createHarness } from 'rti-driver-test-harness';

const harness = createHarness({
    driver: path.resolve(__dirname, '../../dist/index.js'),
    system: { Version: '25.0', IPAddress: '127.0.0.1' },
    config: {
        // Values returned by Config.Get() — mirrors ConfigSettings.xml entries
        'DeviceIP':   '192.168.1.100',
        'DevicePort': '4998',
    },
});

describe('My Driver', () => {
    beforeAll(harness.setup);
    afterAll(harness.teardown);

    it('connects and reports power state', async () => {
        await harness.expectSysvar('PowerOnP01', true, { timeout: 15_000 });
    });
});
```

## API

### `createHarness(options)`

Returns a `Harness` instance. Call `setup` / `teardown` from `beforeAll` / `afterAll`.

#### `HarnessOptions`

| Field | Type | Description |
|---|---|---|
| `driver` | `string` | Absolute path to the compiled driver JS bundle |
| `helpers` | `string` | *(optional)* Absolute path to a JS file loaded into the same context after the driver |
| `system` | `SystemOpts` | *(optional)* Overrides for `System` object properties (`Version`, `IPAddress`, `MACAddress`, `LogLevel`, `IPNetMask`) |
| `config` | `Record<string, string>` | *(optional)* Key/value pairs returned by `Config.Get` — mirrors `ConfigSettings.xml` entries |
| `remotes` | `RemoteSpec[]` | *(optional)* Virtual two-way panels to emulate — see [Remotes](#remotes) |
| `pre` | `Hook[]` | *(optional)* Processes / commands to launch before the driver loads |
| `post` | `Hook[]` | *(optional)* Commands to run after all tests finish |

#### Hooks

A **spawn hook** starts a long-running process (e.g. a device emulator) and optionally waits for it to warm up before the driver loads:

```ts
{
    name:     'device-emulator',
    spawn:    '/path/to/emulator',
    args:     ['--port', '4998'],
    logFile:  path.resolve(__dirname, 'emulator.log'),
    warmupMs: 5_000,                  // wait this long before loading the driver
}
```

A **shell hook** runs a one-shot command and waits for it to finish:

```ts
{
    name:  'reset-state',
    shell: 'curl -s http://device/reset',
}
```

Hooks in `pre` run in order before the driver loads. Hooks in `post` run after all tests finish.

### Remotes

Remotes emulate the physical RTI panels listed in `SYSTEM::TwoWayDeviceList`. Each entry maps to one view ID — the space-separated list of IDs the driver reads from `Config.Get("SYSTEM::TwoWayDeviceList")`. Supply either a bare view ID or `{ id, name }` when the driver identifies panels by name via `System.GetViewName`:

```ts
remotes: [
    { id: 1, name: 'panel-a' },
    { id: 2, name: 'panel-b' },
]
```

Retrieve a handle with `harness.remote(id)`.

### `Harness`

#### Assertions

```ts
// Rejects on timeout — test fails automatically.
await harness.expectSysvar('PowerOnP01', true,  { timeout: 15_000 });
await harness.expectSysvar('InputP01',   (v) => v !== '', { timeout: 10_000 });

// Resolves true/false instead of throwing — for non-fatal checks.
const ok = await harness.waitForSysvar('VolumeP01', 50);

// Assert that System.SignalEvent was called with a given event name.
await harness.expectEvent('PowerStateChanged', { timeout: 10_000 });
```

Both `expectSysvar` / `waitForSysvar` accept either an exact value (strict equality) or a predicate function. If the System Variable already satisfies the condition at call time, the assertion resolves immediately without waiting.

#### `act` — trigger and assert together

When a driver call is expected to produce events or sysvar changes, use `act` to register all expectations and fire the action in a single statement:

```ts
await harness.act(
    () => remoteA.call('transport', 1, 'play'),
    harness.expectEvent('PlayingP01',  { timeout: 10_000 }),
    harness.expectSysvar('PlayingP01', true, { timeout: 10_000 }),
);
```

`act` registers every expectation listener, then fires the action, then waits for all expectations to resolve. This eliminates the footgun of forgetting to register listeners before the action fires: because JavaScript evaluates all arguments before calling the function, the expectation listeners are always set up before the action runs. Any mix of `expectEvent`, `expectSysvar`, `expectViewSysvar`, and `waitFor*` variants may be passed as expectations.

#### Calling System Functions

```ts
// Calls the named driver function directly, as Integration Designer would.
harness.call('setVolume', zoneId, 50, remoteId);
```

Throws if the function is not present in the global scope after the driver loads.

#### Utilities

```ts
await harness.delay(2_000);   // async pause between calls
harness.monitor;               // the underlying Monitor EventEmitter
harness.system;                // the System shim instance
```

### `VirtualRemote`

Obtained from `harness.remote(id)`. All sysvar methods work identically to their `Harness` counterparts.

#### View-scoped System Variables

Drivers use the `%` suffix convention (see the RTI SDK _Views_ section) to maintain per-panel state — a System Variable declared as `sysvar="MenuTitle%"` in `SystemVariables.xml` results in a separate write per view ID: `MenuTitle%1`, `MenuTitle%2`, etc. `expectViewSysvar` / `waitForViewSysvar` build that suffixed name automatically:

```ts
// Asserts "MenuTitle%1" (view 1's copy of the variable) for remoteA
await remoteA.expectViewSysvar('MenuTitle', (v) => v !== '', { timeout: 5_000 });
```

#### Simulating panel actions

System Functions that take a `deviceid` parameter receive the view ID of the panel that triggered the call. `VirtualRemote.call` automatically appends the remote's view ID as the last argument, matching how the XP runtime delivers `deviceid` values:

```ts
// Calls setInput(zoneId, 'HDMI1', viewId) — viewId is appended automatically.
remoteA.call('setInput', zoneId, 'HDMI1');
```

To simulate a panel scrolling an Item List (firing `OnScrollInfoFunc`):

```ts
// Fire OnScrollInfoFunc on 'MenuList%1' with this remote's view ID.
remoteA.scrollViewList('MenuList', highlight, top);

// Fire OnScrollInfoFunc on a non-view-scoped list by exact name.
remoteA.scrollList('PlaylistItems', highlight, top);
```

## Writing tests

### Structure

```ts
import { describe, it, beforeAll, afterAll } from 'vitest';
import { createHarness } from 'rti-driver-test-harness';

const harness = createHarness({ ... });
const remoteA = harness.remote(1);

describe('My Driver', () => {
    beforeAll(harness.setup);
    afterAll(harness.teardown);

    it('connects and reports power on', async () => {
        await harness.expectSysvar('PowerOnP01', true, { timeout: 20_000 });
    });

    it('responds to a System Function call', async () => {
        remoteA.call('setInput', zoneId, 'HDMI1');
        await remoteA.expectViewSysvar('InputP01', 'HDMI1', { timeout: 5_000 });
    });
});
```

### Test sequencing

`beforeAll` / `afterAll` run once per `describe` block. Tests within a block share driver state — the driver keeps its TCP connections open and all System Variable values persist between `it` blocks. Write tests so that each one either establishes its own preconditions or clearly depends on the state left by the previous test.

### Debugging failures

When a System Variable assertion times out the error message includes the actual value:

```
[HARNESS] Sysvar "PowerOnP01" did not reach expected value within 15000ms — actual: false
```

To trace all writes to a specific variable during a test, subscribe to the monitor's `sysvar` event:

```ts
harness.monitor.on('sysvar', (name: string, value: unknown) => {
    if (name === 'PowerOnP01') console.log(`PowerOnP01 → ${value}`);
});
```

To trace all System Events fired by the driver:

```ts
harness.monitor.on('event', (name: string) => console.log(`[EVENT] ${name}`));
```
