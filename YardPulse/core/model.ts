/*
 * Pure yard model: turns raw slot rows into blocks, KPIs and change sets.
 * No PCF or DOM dependencies, so it runs in unit tests and in the demo as-is.
 */

export type SlotState = "free" | "occupied" | "reserved" | "blocked";
export type ColorBy = "status" | "dwell";

/** One row as it comes out of the dataset, before any interpretation. */
export interface RawSlot {
    id: string;
    block: string | null;
    row: number | null;
    bay: number | null;
    status: string | null;
    dwellHours: number | null;
    unit: string | null;
}

export interface Slot {
    id: string;
    key: string;
    block: string;
    row: number;
    bay: number;
    state: SlotState;
    statusLabel: string;
    dwellHours: number | null;
    unit: string;
    overdue: boolean;
}

export interface Block {
    name: string;
    rows: number;
    bays: number;
    /** Keyed by `${row}:${bay}`. */
    slots: Map<string, Slot>;
    occupied: number;
    capacity: number;
}

export interface Kpis {
    capacity: number;
    occupied: number;
    free: number;
    reserved: number;
    blocked: number;
    /** Occupied share of usable (non-blocked) slots, 0–100. */
    occupancyPct: number;
    avgDwellHours: number | null;
    overdue: number;
}

export interface YardModel {
    blocks: Block[];
    kpis: Kpis;
    /** Rows that could not be placed (missing block/row/bay). */
    skipped: number;
}

// Matched against the lower-cased label, English and Dutch.
const STATE_WORDS: [SlotState, RegExp][] = [
    ["free", /\b(free|empty|available|vrij|leeg|beschikbaar)\b/],
    ["reserved", /\b(reserved|booked|planned|gereserveerd|geboekt|gepland)\b/],
    ["blocked", /\b(blocked|hold|closed|damaged|out of service|geblokkeerd|gesloten|defect)\b/],
];

export function normalizeStatus(label: string | null | undefined): SlotState {
    const text = (label ?? "").trim().toLowerCase();
    if (!text) return "free";
    for (const [state, pattern] of STATE_WORDS) {
        if (pattern.test(text)) return state;
    }
    return "occupied";
}

export function slotKey(block: string, row: number, bay: number): string {
    return `${block}|${row}|${bay}`;
}

function toPosition(value: number | null): number | null {
    if (value === null || !Number.isFinite(value)) return null;
    const n = Math.round(value);
    return n >= 1 ? n : null;
}

// Natural order, so "B2" sorts before "B10".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function buildYard(rows: RawSlot[], dwellAlertHours: number): YardModel {
    const blocks = new Map<string, Block>();
    let skipped = 0;

    for (const raw of rows) {
        const blockName = raw.block?.trim();
        const row = toPosition(raw.row);
        const bay = toPosition(raw.bay);
        if (!blockName || row === null || bay === null) {
            skipped++;
            continue;
        }

        const state = normalizeStatus(raw.status);
        const dwell = raw.dwellHours !== null && Number.isFinite(raw.dwellHours) ? Math.max(0, raw.dwellHours) : null;
        const slot: Slot = {
            id: raw.id,
            key: slotKey(blockName, row, bay),
            block: blockName,
            row,
            bay,
            state,
            statusLabel: raw.status?.trim() || "Free",
            dwellHours: state === "occupied" ? dwell : null,
            unit: raw.unit?.trim() ?? "",
            overdue: state === "occupied" && dwell !== null && dwell >= dwellAlertHours,
        };

        let block = blocks.get(blockName);
        if (!block) {
            block = { name: blockName, rows: 0, bays: 0, slots: new Map(), occupied: 0, capacity: 0 };
            blocks.set(blockName, block);
        }
        const cell = `${row}:${bay}`;
        // Two records claiming one slot: keep the first, the grid can only show one.
        if (block.slots.has(cell)) {
            skipped++;
            continue;
        }
        block.slots.set(cell, slot);
        block.rows = Math.max(block.rows, row);
        block.bays = Math.max(block.bays, bay);
    }

    const kpis: Kpis = { capacity: 0, occupied: 0, free: 0, reserved: 0, blocked: 0, occupancyPct: 0, avgDwellHours: null, overdue: 0 };
    let dwellSum = 0;
    let dwellCount = 0;

    for (const block of blocks.values()) {
        for (const slot of block.slots.values()) {
            kpis[slot.state]++;
            if (slot.state !== "blocked") block.capacity++;
            if (slot.state === "occupied") block.occupied++;
            if (slot.overdue) kpis.overdue++;
            if (slot.dwellHours !== null) {
                dwellSum += slot.dwellHours;
                dwellCount++;
            }
        }
        kpis.capacity += block.capacity;
    }
    kpis.occupancyPct = kpis.capacity ? Math.round((kpis.occupied / kpis.capacity) * 1000) / 10 : 0;
    kpis.avgDwellHours = dwellCount ? Math.round((dwellSum / dwellCount) * 10) / 10 : null;

    return {
        blocks: [...blocks.values()].sort((a, b) => collator.compare(a.name, b.name)),
        kpis,
        skipped,
    };
}

/** What a viewer would notice: a different state, unit or overdue flag. */
function signature(slot: Slot): string {
    return `${slot.state}|${slot.unit}|${slot.overdue ? 1 : 0}`;
}

export function snapshot(model: YardModel): Map<string, string> {
    const out = new Map<string, string>();
    for (const block of model.blocks) {
        for (const slot of block.slots.values()) out.set(slot.key, signature(slot));
    }
    return out;
}

/** Slot keys whose visible state changed since `previous`. Empty on first render. */
export function changedSlots(previous: Map<string, string> | null, model: YardModel): Set<string> {
    const changed = new Set<string>();
    if (!previous) return changed;
    for (const block of model.blocks) {
        for (const slot of block.slots.values()) {
            const before = previous.get(slot.key);
            if (before !== undefined && before !== signature(slot)) changed.add(slot.key);
        }
    }
    return changed;
}

/**
 * Dwell bucket 0–4 for the sequential scale: four even steps up to the alert
 * threshold, and 4 at or beyond it. Null when the slot has no unit.
 */
export function dwellBucket(slot: Slot, dwellAlertHours: number): number | null {
    if (slot.state !== "occupied" || slot.dwellHours === null) return null;
    if (slot.overdue) return 4;
    const threshold = Math.max(1, dwellAlertHours);
    return Math.min(3, Math.floor((slot.dwellHours / threshold) * 4));
}

export function matchesQuery(slot: Slot, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return slot.unit.toLowerCase().includes(q) || slot.statusLabel.toLowerCase().includes(q);
}

export function formatHours(hours: number | null): string {
    if (hours === null) return "–";
    if (hours < 48) return `${Math.round(hours)} h`;
    const days = hours / 24;
    return `${days >= 10 ? Math.round(days) : Math.round(days * 10) / 10} d`;
}
