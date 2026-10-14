/**
 * Adapter registry. Every `src/adapters/<name>.js` (files starting with "_" are helpers) is imported and
 * registered by its `state` code, so vendoring a new state is "drop in one file". See src/adapters/_contract.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ADAPTER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'adapters');

const REQUIRED = ['state', 'stateName', 'mode', 'source', 'lookup'];

export function validateAdapter(a, label = 'adapter') {
    for (const key of REQUIRED) {
        if (a?.[key] === undefined) throw new Error(`${label}: missing "${key}"`);
    }
    if (!/^[A-Z]{2}$/.test(a.state)) throw new Error(`${label}: state must be a 2-letter upper-case code`);
    if (!['opendata', 'live'].includes(a.mode)) throw new Error(`${label}: mode must be "opendata" or "live"`);
    if (typeof a.lookup !== 'function') throw new Error(`${label}: lookup must be a function`);
    return a;
}

export class Registry {
    constructor(adapters = []) {
        this.byState = new Map();
        adapters.forEach((a) => this.register(a));
    }

    register(adapter) {
        validateAdapter(adapter, `adapter ${adapter?.state ?? '?'}`);
        if (this.byState.has(adapter.state)) throw new Error(`Two adapters claim state ${adapter.state}`);
        this.byState.set(adapter.state, adapter);
        return this;
    }

    get(state) {
        return this.byState.get(String(state ?? '').toUpperCase()) ?? null;
    }

    list() {
        return [...this.byState.values()].sort((a, b) => a.state.localeCompare(b.state));
    }

    states() {
        return this.list().map((a) => a.state);
    }
}

/** Import all adapter modules from src/adapters. A module may export one adapter or an array of them. */
export async function loadRegistry(dir = ADAPTER_DIR) {
    const registry = new Registry();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort();
    for (const file of files) {
        const mod = await import(pathToFileURL(path.join(dir, file)).href);
        const exported = mod.default ?? mod.adapter ?? mod.adapters;
        for (const a of [exported].flat()) registry.register(a);
    }
    return registry;
}

/** State names and a few spellings people type, mapped to 2-letter codes (only states with adapters matter). */
const NAMES = {
    TEXAS: 'TX', COLORADO: 'CO', 'NEW YORK': 'NY', CONNECTICUT: 'CT', OREGON: 'OR', 'DISTRICT OF COLUMBIA': 'DC',
    'WASHINGTON DC': 'DC', 'WASHINGTON D.C.': 'DC', 'D.C.': 'DC', FLORIDA: 'FL', WASHINGTON: 'WA', GEORGIA: 'GA', ARIZONA: 'AZ',
};

export function normalizeState(value) {
    const raw = String(value ?? '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(raw)) return raw;
    return NAMES[raw] ?? null;
}
