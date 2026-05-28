import * as net from 'net';
import type Monitor from './monitor';

let _handleCounter = 0;
const _nextHandle = (): number => ++_handleCounter;

export interface SystemOpts {
    Version?:    string;
    IPAddress?:  string;
    MACAddress?: string;
    LogLevel?:   number;
    IPNetMask?:  string;
}

export function createSystem(opts: SystemOpts = {}) {
    return {
        Version:    opts.Version    ?? '25.0',
        IPAddress:  opts.IPAddress  ?? '127.0.0.1',
        MACAddress: opts.MACAddress ?? '00:00:00:00:00:00',
        LogLevel:   opts.LogLevel   ?? 0,
        IPNetMask:  opts.IPNetMask  ?? '255.255.255.0',

        Print:                 (msg: string): boolean           => { process.stdout.write('[DRV] ' + msg + '\n'); return true; },
        PrintMultiline:        (msg: string): boolean           => { process.stdout.write('[DRV] ' + msg + '\n'); return true; },
        Sleep:                 (_ms: number): boolean           => true,
        GetURL:                (_url: string): string           => '',
        ConvertFromUTF8:       (s: string): string              => s,
        ConvertToUTF8:         (s: string): string              => s,
        RunSystemMacro:        (_n: number): boolean            => true,
        SignalEvent:           (name: string): boolean          => { console.log('[EVENT] ' + name); return true; },
        SetPriority:           (_n: number): boolean            => true,
        StartUPnPScan:         (): boolean                      => true,
        GetLocalTime:          (): string                       => new Date().toLocaleString(),
        GetUTCTime:            (): string                       => new Date().toUTCString(),
        GetLocalTimeInSeconds: (): number                       => Math.floor(Date.now() / 1000),
        GetUTCTimeInSeconds:   (): number                       => Math.floor(Date.now() / 1000),
        Compress:              (s: string): string              => s,
        Uncompress:            (s: string, _n: number): string  => s,
        GetRandomInteger:      (lo: number, hi: number): number => Math.floor(Math.random() * (hi - lo + 1)) + lo,
        LogError:              (msg: string): boolean           => { console.error('[ERR] ' + msg); return true; },
        LogInfo:               (_lv: number, msg: string): boolean => { console.log('[INFO] ' + msg); return true; },
        GetViewName:           (i: number): string              => 'View' + i,
        LoadResource:          (_r: string): string             => '',
        Ping:                  (_addr: string): boolean         => true,
        GetTickCount:          (): number                       => Date.now(),
    };
}

export function createConfig(configMap: Record<string, string> = {}) {
    return {
        Get(key: string): string {
            if (Object.prototype.hasOwnProperty.call(configMap, key)) return configMap[key];
            console.warn('[CONFIG] Unknown key: ' + key + ' — returning empty string');
            return '';
        }
    };
}

export function createSystemVars(monitor: Monitor | null) {
    const store: Record<string, unknown> = {};
    return {
        OnSysVarChangeFunc: null as ((varname: string, data: unknown, prev: unknown) => void) | null,
        Write(varname: string, data: unknown): boolean {
            const prev = store[varname];
            store[varname] = data;
            if (monitor && prev !== data) monitor.onSysVarChange(varname, data, prev);
            return true;
        },
        Read(varname: string): unknown {
            return Object.prototype.hasOwnProperty.call(store, varname) ? store[varname] : '';
        },
        AddSubscription:    (_id: unknown): boolean => true,
        RemoveSubscription: (_id: unknown): boolean => true,
    };
}

export class SystemVarsList {
    private _name:  string;
    private _items: unknown[];
    Size:             number;
    MarkedCount:      number;
    OnScrollInfoFunc: ((view: number, highlight: number, top: number) => void) | null;

    constructor(varname: string) {
        this._name            = varname;
        this._items           = [];
        this.Size             = 0;
        this.MarkedCount      = 0;
        this.OnScrollInfoFunc = null;
    }

    Open(): boolean                                   { return true; }
    Close(): boolean                                  { return true; }
    Insert(data: unknown): boolean                    { this._items.push(data); this.Size = this._items.length; return true; }
    InsertWithImage(d: unknown, _: unknown): boolean  { this._items.push(d);    this.Size = this._items.length; return true; }
    InsertAt(i: number, data: unknown): boolean       { this._items.splice(i, 0, data); this.Size = this._items.length; return true; }
    RemoveAll(): boolean                              { this._items = []; this.Size = 0; return true; }
    RemoveAt(i: number): boolean                      { this._items.splice(i, 1); this.Size = this._items.length; return true; }
    ReadAt(i: number): unknown                        { return this._items[i]; }
    ModifyAt(i: number, data: unknown): boolean       { this._items[i] = data; return true; }
    SetMarked(_i: number): boolean                    { return true; }
    AddMarked(_i: number): boolean                    { return true; }
    RemoveMarked(_i: number): boolean                 { return true; }
    IsMarked(_i: number): boolean                     { return false; }
    GetMarked(_i: number): number                     { return -1; }
    SetIndexes(_s: unknown, _t: unknown): boolean     { return true; }
}

export class Timer {
    Handle:               number;
    State:                number;
    Interval:             number;
    UseHandleInCallbacks: boolean;
    private _ref:         NodeJS.Timeout | null;

    constructor() {
        this.Handle               = _nextHandle();
        this.State                = 0;
        this.Interval             = 0;
        this.UseHandleInCallbacks = false;
        this._ref                 = null;
    }

    Start(callback: (handle?: number) => void, timeout: number): boolean {
        this.Stop();
        this.State    = 1;
        this.Interval = timeout;
        const h    = this.Handle;
        const self = this;
        this._ref  = setTimeout(() => {
            self.State = 0;
            self._ref  = null;
            try { callback(self.UseHandleInCallbacks ? h : undefined); }
            catch (e) { console.error('[TIMER #' + h + '] callback threw:', e); }
        }, timeout);
        return true;
    }

    Stop(): boolean {
        if (this._ref !== null) { clearTimeout(this._ref); this._ref = null; }
        this.State = 0;
        return true;
    }
}

export class TCP {
    Handle:                number;
    UseHandleInCallbacks:  boolean;
    OnConnectFunc:         ((handle?: number) => void) | null;
    OnDisconnectFunc:      ((handle?: number) => void) | null;
    OpenState:             number;
    ConnectState:          number;
    TxQueueDepth:          number;
    HeartbeatConnectState: boolean;
    private _onCommRx:     (data: string, handle?: number) => void;
    private _socket:       net.Socket | null;

    constructor(onCommRx: (data: string, handle?: number) => void, host?: string, port?: string | number) {
        this.Handle                = _nextHandle();
        this.UseHandleInCallbacks  = false;
        this.OnConnectFunc         = null;
        this.OnDisconnectFunc      = null;
        this.OpenState             = 0;
        this.ConnectState          = 0;
        this.TxQueueDepth          = 0;
        this.HeartbeatConnectState = false;
        this._onCommRx             = onCommRx;
        this._socket               = null;

        // Defer connect by one tick so the caller can set OnConnectFunc after construction.
        if (host && port) setImmediate(() => this._connect(host, parseInt(String(port), 10)));
    }

    private _connect(host: string, port: number): void {
        console.log('[TCP #' + this.Handle + '] Connecting to ' + host + ':' + port);
        const sock = new net.Socket();
        this._socket = sock;

        sock.connect(port, host, () => {
            this.ConnectState = 1;
            console.log('[TCP #' + this.Handle + '] Connected');
            if (this.OnConnectFunc) this.OnConnectFunc(this.UseHandleInCallbacks ? this.Handle : undefined);
        });

        sock.on('data', (buf: Buffer) => {
            const str     = buf.toString('latin1');
            const preview = str.substring(0, 120).replace(/[\r\n]+/g, ' ↵ ');
            console.log('[TCP #' + this.Handle + ' RX] ' + buf.length + 'B │ ' + preview);
            this._onCommRx(str, this.UseHandleInCallbacks ? this.Handle : undefined);
        });

        sock.on('close', () => {
            this.ConnectState = 0;
            console.log('[TCP #' + this.Handle + '] Disconnected');
            if (this.OnDisconnectFunc) this.OnDisconnectFunc(this.UseHandleInCallbacks ? this.Handle : undefined);
        });

        sock.on('error', (err: Error) => {
            console.error('[TCP #' + this.Handle + '] Socket error: ' + err.message);
        });
    }

    Write(data: string): boolean {
        if (this._socket && this.ConnectState) {
            this._socket.write(Buffer.from(data, 'latin1'));
            return true;
        }
        console.warn('[TCP #' + this.Handle + '] Write called but not connected');
        return false;
    }

    Open(host: string, port: string | number): boolean {
        this._connect(host, parseInt(String(port), 10));
        return true;
    }

    Close(): boolean {
        if (this._socket) { this._socket.destroy(); this._socket = null; }
        this.ConnectState = 0;
        return true;
    }

    Read(_t?: unknown): string         { return ''; }
    WaitForRx(_t?: unknown): boolean   { return false; }
    AddRxFraming(): boolean            { return false; }
    AddRxHTTPFraming(): boolean        { return false; }
    SetTxInterMsgDelay(): boolean      { return true; }
    EnableHeartbeat(): boolean         { return true; }
    HeartbeatReceived(): boolean       { return true; }
}

export const Persistence = {
    Write:  (_k: string, _v: unknown): boolean => true,
    Read:   (_k: string): string               => '',
    Delete: (_k: string): boolean              => true,
    Save:   (): boolean                        => true,
};
