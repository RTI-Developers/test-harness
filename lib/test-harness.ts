import * as fs   from 'fs';
import * as vm   from 'vm';
import * as path from 'path';
import { spawn, exec } from 'child_process';
import type { ChildProcess } from 'child_process';

import { createSystem, createConfig, createSystemVars, SystemVarsList, Timer, TCP, Persistence } from './shims';
import type { SystemOpts } from './shims';
import Monitor from './monitor';
import type { ConditionPredicate } from './monitor';

// ─── Hook types ───────────────────────────────────────────────────────────────

interface SpawnHook {
    name?:     string;
    spawn:     string;
    args?:     string[];
    logFile?:  string;
    warmupMs?: number;
}

interface ShellHook {
    name?:  string;
    shell:  string;
}

type Hook = SpawnHook | ShellHook;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * A virtual two-way remote declared in `HarnessOptions.remotes`.
 * Supply `{ id, name }` when the driver matches remotes by name via
 * `System.GetViewName` — the harness will patch that shim to return
 * the given name for the specified view ID.
 */
export type RemoteSpec = number | { id: number; name: string };

export interface HarnessOptions {
    /** Absolute path to the compiled driver JS. */
    driver:   string;
    /** Absolute path to a helpers JS file loaded after the driver. */
    helpers?: string;
    system?:  SystemOpts;
    config?:  Record<string, string>;
    /**
     * Virtual two-way remotes to emulate.  Each entry is either a bare view ID
     * or `{ id, name }` when the driver identifies remotes by name via
     * `System.GetViewName`.  View IDs are joined as a space-separated string
     * and injected into `SYSTEM::TwoWayDeviceList`.
     */
    remotes?: RemoteSpec[];
    /** Processes / commands to launch before tests run. */
    pre?:     Hook[];
    /** Cleanup commands to run after tests finish. */
    post?:    Hook[];
}

export interface WaitOptions {
    /** Maximum time to wait in ms (default: 30 000). */
    timeout?: number;
}

/**
 * A handle to a virtual two-way remote (one entry in SYSTEM::TwoWayDeviceList).
 * Use it to simulate the actions a physical RTI panel would take.
 */
export interface VirtualRemote {
    /** The view ID assigned to this remote (matches the value in TwoWayDeviceList). */
    readonly id: number;

    /**
     * Assert on a sysvar by its exact name.
     * Rejects with a descriptive error on timeout so the test fails automatically.
     */
    expectSysvar(name: string, predicate: (value: unknown) => boolean, opts?: WaitOptions): Promise<void>;
    expectSysvar(name: string, expected: unknown, opts?: WaitOptions): Promise<void>;

    /** Same as `expectSysvar` but resolves `true`/`false` instead of throwing. */
    waitForSysvar(name: string, predicate: (value: unknown) => boolean, opts?: WaitOptions): Promise<boolean>;
    waitForSysvar(name: string, expected: unknown, opts?: WaitOptions): Promise<boolean>;

    /**
     * Assert on a view-specific (per-remote) sysvar.  The full sysvar name is
     * constructed as `baseName + '%' + id` — e.g. `"BrowseListTitleP01"` on
     * remote 1 resolves to `"BrowseListTitleP01%1"`.
     * Rejects with a descriptive error on timeout so the test fails automatically.
     */
    expectViewSysvar(baseName: string, predicate: (value: unknown) => boolean, opts?: WaitOptions): Promise<void>;
    expectViewSysvar(baseName: string, expected: unknown, opts?: WaitOptions): Promise<void>;

    /** Same as `expectViewSysvar` but resolves `true`/`false` instead of throwing. */
    waitForViewSysvar(baseName: string, predicate: (value: unknown) => boolean, opts?: WaitOptions): Promise<boolean>;
    waitForViewSysvar(baseName: string, expected: unknown, opts?: WaitOptions): Promise<boolean>;

    /**
     * Simulate this remote scrolling a list — fires `OnScrollInfoFunc` on the
     * named `SystemVarsList` with this remote's view ID.
     *
     * @param listName  The exact sysvar name passed to `new SystemVarsList(name)`.
     * @param highlight Zero-based index of the highlighted row.
     * @param top       Zero-based index of the topmost visible row.
     */
    scrollList(listName: string, highlight: number, top: number): void;

    /**
     * Like `scrollList` but for view-specific lists.  The full list name is
     * constructed as `baseName + '%' + id` — e.g. `"BrowseListP01"` on remote 1
     * resolves to `"BrowseListP01%1"`.
     */
    scrollViewList(baseName: string, highlight: number, top: number): void;

    /**
     * Convenience wrapper for calling a driver function with this remote's
     * view ID automatically appended as the last argument (the `deviceid`).
     */
    call(fn: string, ...args: unknown[]): unknown;
}

export interface Harness {
    /** Pass to `beforeAll`. Installs shims, runs pre-hooks, loads the driver. */
    setup():    Promise<void>;
    /** Pass to `afterAll`. Kills spawned processes, runs post-hooks. */
    teardown(): Promise<void>;

    /**
     * Rejects with a descriptive error on timeout — the test fails automatically.
     * Pass an exact value for strict equality, or a predicate for custom matching.
     */
    expectSysvar(name: string, predicate: (value: unknown) => boolean, opts?: WaitOptions): Promise<void>;
    expectSysvar(name: string, expected: unknown, opts?: WaitOptions): Promise<void>;

    /**
     * Resolves when `name` is signalled via `System.SignalEvent`.
     * Rejects with a descriptive error on timeout.
     */
    expectEvent(name: string, opts?: WaitOptions): Promise<void>;

    /** Same as `expectSysvar` but resolves `true`/`false` instead of throwing. */
    waitForSysvar(name: string, predicate: (value: unknown) => boolean, opts?: WaitOptions): Promise<boolean>;
    waitForSysvar(name: string, expected: unknown, opts?: WaitOptions): Promise<boolean>;

    /** Same as `expectEvent` but resolves `true`/`false` instead of throwing. */
    waitForEvent(name: string, opts?: WaitOptions): Promise<boolean>;

    /**
     * Registers all expectations, fires `action`, then waits for every
     * expectation to settle.
     *
     * Because JS evaluates arguments left-to-right before invoking the
     * function, every expectation listener is registered before the action
     * fires — no manual pre-registration is required.
     *
     * @example
     * await harness.act(
     *     () => remoteA.call('transport', 1, 'play'),
     *     harness.expectEvent('PlayingP01',  { timeout: 10_000 }),
     *     harness.expectSysvar('PlayingP01', true, { timeout: 10_000 }),
     * );
     */
    act(action: () => void, ...expectations: Promise<unknown>[]): Promise<void>;

    /** Call a driver-injected global function by name. Throws if not found. */
    call(fn: string, ...args: unknown[]): unknown;

    /** Async pause — use between driver calls in a test step sequence. */
    delay(ms: number): Promise<void>;

    /**
     * Get a handle to one of the virtual remotes declared in `options.remotes`.
     * Throws if `id` was not included in `options.remotes`.
     */
    remote(id: number): VirtualRemote;

    readonly monitor: Monitor;
    readonly system:  SystemStatic;
}

// ─── RTI globals type ─────────────────────────────────────────────────────────
// sdk-types declares these as `const` in the global scope (for driver authoring).
// The harness needs to install its shim implementations at runtime, so we cast
// `global` to this writable shape instead of redeclaring the globals as `var`.

type RTIGlobals = {
    System:         SystemStatic;
    Config:         ConfigStatic;
    SystemVars:     SystemVarsStatic;
    SystemVarsList: SystemVarsListConstructor;
    Timer:          TimerConstructor;
    TCP:            TCPConstructor;
    Persistence:    PersistenceStatic;
};

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createHarness(options: HarnessOptions): Harness {
    const monitor               = new Monitor();
    let   _system:                SystemStatic;
    let   _systemVars:            ReturnType<typeof createSystemVars> | null = null;
    const _procs: ChildProcess[]  = [];
    // Populated during setup() as the driver calls `new SystemVarsList(name)`.
    const _lists                  = new Map<string, InstanceType<typeof SystemVarsList>>();

    // Normalise RemoteSpec[] → parallel id list and name map (built once at construction).
    const _remoteIds:   number[]            = (options.remotes ?? []).map(s => typeof s === 'number' ? s : s.id);
    const _remoteNames: Map<number, string> = new Map(
        (options.remotes ?? [])
            .filter((s): s is { id: number; name: string } => typeof s !== 'number')
            .map(s => [s.id, s.name]),
    );

    async function _runHooks(hooks: Hook[], label: string): Promise<void> {
        for (const hook of hooks) {
            const name = hook.name ?? ('spawn' in hook ? hook.spawn : hook.shell);

            if ('spawn' in hook) {
                console.log(`[HARNESS] ${label}: spawn ${name}`);
                const fd   = hook.logFile ? fs.openSync(hook.logFile, 'w') : null;
                const proc = spawn(hook.spawn, hook.args ?? [], {
                    stdio: fd !== null ? (['ignore', fd, fd] as ['ignore', number, number]) : 'inherit',
                });
                proc.on('exit', (code: number | null) => console.log(`[HARNESS] ${name} exited (${code})`));
                _procs.push(proc);

                if (hook.warmupMs) {
                    console.log(`[HARNESS] Warmup: ${hook.warmupMs / 1000}s …`);
                    await new Promise<void>(r => setTimeout(r, hook.warmupMs));
                }
            } else {
                console.log(`[HARNESS] ${label}: shell: ${hook.shell}`);
                await new Promise<void>(r => exec(hook.shell, (err, out, err2) => {
                    if (err)  console.error('[HARNESS] Hook error:', err.message);
                    if (out)  process.stdout.write(out);
                    if (err2) process.stderr.write(err2);
                    r();
                }));
            }
        }
    }

    function _toPredicate(expected: unknown): ConditionPredicate {
        return typeof expected === 'function'
            ? expected as ConditionPredicate
            : (v: unknown) => v === expected;
    }

    async function setup(): Promise<void> {
        _system = createSystem(options.system ?? {});

        // Merge config, letting options.remotes win over any explicit TwoWayDeviceList.
        const configMap: Record<string, string> = { ...(options.config ?? {}) };
        if (options.remotes !== undefined) {
            configMap['SYSTEM::TwoWayDeviceList'] = _remoteIds.join(' ');
        }

        // sdk-types declares the RTI globals as `const` (appropriate for driver authors).
        // The harness must install its shim implementations at runtime, so we write
        // through a typed cast rather than re-declaring the globals as `var`.
        const _g = global as unknown as RTIGlobals;

        _g.System     = _system;
        _g.Config     = createConfig(configMap);
        _systemVars   = createSystemVars(monitor);
        _g.SystemVars = _systemVars;

        // Wrap SystemVarsList so we can intercept every construction the driver
        // makes and look up lists by name later (for scrollList emulation).
        _g.SystemVarsList = class extends SystemVarsList {
            constructor(varname: string) {
                super(varname);
                _lists.set(varname, this);
            }
        } as unknown as SystemVarsListConstructor;

        _g.Timer       = Timer       as unknown as TimerConstructor;
        _g.TCP         = TCP         as unknown as TCPConstructor;
        _g.Persistence = Persistence;

        const _origSignalEvent    = _g.System.SignalEvent.bind(_g.System);
        _g.System.SignalEvent = (name: string): boolean => { monitor.onEvent(name); return _origSignalEvent(name); };

        if (_remoteNames.size > 0) {
            const _origGetViewName = _g.System.GetViewName.bind(_g.System);
            // The driver calls GetViewName(i) with the 0-based loop index into TwoWayDeviceList,
            // not the view ID itself — map through _remoteIds to get the right name.
            _g.System.GetViewName = (i: number): string => {
                const viewId = _remoteIds[i];
                return (viewId !== undefined ? _remoteNames.get(viewId) : undefined) ?? _origGetViewName(i);
            };
        }

        await _runHooks(options.pre ?? [], 'pre');

        if (!fs.existsSync(options.driver)) {
            throw new Error(`[HARNESS] Driver not found: ${options.driver}`);
        }
        console.log(`[HARNESS] Loading driver: ${path.basename(options.driver)}`);
        vm.runInThisContext(fs.readFileSync(options.driver, 'utf8'), { filename: path.basename(options.driver) });
        console.log('[HARNESS] Driver loaded');

        if (options.helpers && fs.existsSync(options.helpers)) {
            console.log(`[HARNESS] Loading helpers: ${path.basename(options.helpers)}`);
            vm.runInThisContext(fs.readFileSync(options.helpers, 'utf8'), { filename: path.basename(options.helpers) });
        }
    }

    async function teardown(): Promise<void> {
        console.log('[HARNESS] Teardown …');
        for (const p of _procs) { try { p.kill(); } catch (_) {} }
        await _runHooks(options.post ?? [], 'post');
    }

    async function waitForSysvar(name: string, expected: unknown, opts?: WaitOptions): Promise<boolean> {
        const predicate = _toPredicate(expected);
        // Resolve immediately if the sysvar already satisfies the condition — the monitor
        // only fires on future Write calls, so it would time out on an already-set value.
        if (_systemVars !== null && predicate(_systemVars.Read(name))) return true;
        return monitor.assert({
            type:            'sysvar',
            sysvar:          name,
            condition:       predicate,
            withinMs:        opts?.timeout ?? 30_000,
            name,
            getCurrentValue: () => _systemVars?.Read(name),
        });
    }

    async function expectSysvar(name: string, expected: unknown, opts?: WaitOptions): Promise<void> {
        const pass = await waitForSysvar(name, expected, opts);
        if (!pass) {
            const timeout = opts?.timeout ?? 30_000;
            const actual  = _systemVars?.Read(name);
            throw new Error(`[HARNESS] Sysvar "${name}" did not reach expected value within ${timeout}ms — actual: ${JSON.stringify(actual)}`);
        }
    }

    async function waitForEvent(name: string, opts?: WaitOptions): Promise<boolean> {
        return monitor.assert({
            type:    'event',
            event:   name,
            withinMs: opts?.timeout ?? 30_000,
            name,
        });
    }

    async function expectEvent(name: string, opts?: WaitOptions): Promise<void> {
        const pass = await waitForEvent(name, opts);
        if (!pass) {
            const timeout = opts?.timeout ?? 30_000;
            throw new Error(`[HARNESS] Event "${name}" was not fired within ${timeout}ms`);
        }
    }

    function call(fn: string, ...args: unknown[]): unknown {
        const g = global as Record<string, unknown>;
        if (typeof g[fn] !== 'function') throw new Error(`[HARNESS] Driver function not found: ${fn}`);
        return (g[fn] as (...a: unknown[]) => unknown)(...args);
    }

    async function act(action: () => void, ...expectations: Promise<unknown>[]): Promise<void> {
        action();
        await Promise.all(expectations);
    }

    function delay(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }

    function remote(id: number): VirtualRemote {
        if (!_remoteIds.includes(id)) {
            throw new Error(`[HARNESS] Remote ID ${id} was not declared in options.remotes`);
        }
        const _viewName = (baseName: string) => `${baseName}%${id}`;

        return {
            id,
            waitForSysvar(name: string, expected: unknown, opts?: WaitOptions): Promise<boolean> {
                return waitForSysvar(name, expected, opts);
            },
            expectSysvar(name: string, expected: unknown, opts?: WaitOptions): Promise<void> {
                return expectSysvar(name, expected, opts);
            },
            waitForViewSysvar(baseName: string, expected: unknown, opts?: WaitOptions): Promise<boolean> {
                return waitForSysvar(_viewName(baseName), expected, opts);
            },
            expectViewSysvar(baseName: string, expected: unknown, opts?: WaitOptions): Promise<void> {
                return expectSysvar(_viewName(baseName), expected, opts);
            },
            scrollList(listName: string, highlight: number, top: number): void {
                const list = _lists.get(listName);
                if (!list) throw new Error(`[HARNESS] No SystemVarsList named "${listName}" found — has the driver been loaded?`);
                if (list.OnScrollInfoFunc) list.OnScrollInfoFunc(id, highlight, top);
            },
            scrollViewList(baseName: string, highlight: number, top: number): void {
                const listName = _viewName(baseName);
                const list = _lists.get(listName);
                if (!list) throw new Error(`[HARNESS] No SystemVarsList named "${listName}" found — has the driver been loaded?`);
                if (list.OnScrollInfoFunc) list.OnScrollInfoFunc(id, highlight, top);
            },
            call(fn: string, ...args: unknown[]): unknown {
                return call(fn, ...args, id);
            },
        };
    }

    return {
        setup,
        teardown,
        waitForSysvar,
        expectSysvar,
        waitForEvent,
        expectEvent,
        act,
        call,
        delay,
        remote,
        get monitor() { return monitor; },
        get system()  { return _system;  },
    };
}
