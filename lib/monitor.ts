import { EventEmitter } from 'events';

export type ConditionPredicate = (value: unknown) => boolean;
export type Condition = 'equals' | 'not_empty' | 'truthy' | 'falsy' | ConditionPredicate;

export interface AssertionSpec {
    type:            'sysvar' | 'event';
    sysvar?:         string;
    event?:          string;
    condition?:      Condition;
    value?:          unknown;
    withinMs?:       number;
    name?:           string;
    /** Called on timeout to capture the live value for the failure log. */
    getCurrentValue?: () => unknown;
}

interface ActiveAssertion extends AssertionSpec {
    _resolve: (pass: boolean) => void;
    _timeout: NodeJS.Timeout;
}

export interface AssertionResult {
    pass: boolean;
    spec: ActiveAssertion;
}

class Monitor extends EventEmitter {
    private _assertions: ActiveAssertion[];
    private _results:    AssertionResult[];

    constructor() {
        super();
        this._assertions = [];
        this._results    = [];
    }

    onSysVarChange(name: string, value: unknown, _prev: unknown): void {
        this.emit('sysvar', name, value, _prev);
        for (let i = this._assertions.length - 1; i >= 0; i--) {
            const a = this._assertions[i];
            if (a.type === 'sysvar' && a.sysvar === name && this._eval(a, value)) {
                this._assertions.splice(i, 1);
                this._pass(a);
            }
        }
    }

    onEvent(name: string): void {
        this.emit('event', name);
        for (let i = this._assertions.length - 1; i >= 0; i--) {
            const a = this._assertions[i];
            if (a.type === 'event' && a.event === name) {
                this._assertions.splice(i, 1);
                this._pass(a);
            }
        }
    }

    assert(spec: AssertionSpec): Promise<boolean> {
        return new Promise((resolve) => {
            const a: ActiveAssertion = {
                ...spec,
                _resolve: resolve,
                _timeout: setTimeout(() => {
                    const idx = this._assertions.indexOf(a);
                    if (idx !== -1) this._assertions.splice(idx, 1);
                    this._fail(a);
                }, spec.withinMs ?? 30000),
            };
            this._assertions.push(a);
        });
    }

    private _eval(a: ActiveAssertion, value: unknown): boolean {
        if (typeof a.condition === 'function') return a.condition(value);
        switch (a.condition) {
            case 'equals':    return value === a.value;
            case 'not_empty': return value !== '' && value !== null && value !== undefined && value !== false;
            case 'truthy':    return !!value;
            case 'falsy':     return !value;
            default:          return value === a.value;
        }
    }

    private _pass(a: ActiveAssertion): void {
        clearTimeout(a._timeout);
        const label = a.name ?? a.sysvar ?? a.event ?? '?';
        console.log('[ASSERT PASS] ' + label);
        this._results.push({ pass: true, spec: a });
        a._resolve(true);
    }

    private _fail(a: ActiveAssertion): void {
        const label = a.name ?? a.sysvar ?? a.event ?? '?';
        const actual = a.getCurrentValue ? ` — actual: ${JSON.stringify(a.getCurrentValue())}` : '';
        console.error('[ASSERT FAIL] ' + label + ' — timed out after ' + (a.withinMs ?? 30000) + 'ms' + actual);
        this._results.push({ pass: false, spec: a });
        a._resolve(false);
    }

    summary(): AssertionResult[] {
        return this._results;
    }
}

export default Monitor;
