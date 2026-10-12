/*
 * A fictional car terminal ("North Quay") that changes hour by hour: vessels
 * discharge into the import blocks, trucks gate in export cars, rail clears
 * block E. Seeded, so the same seed always plays out the same way.
 */
import type { MockRow } from "./mock-context";

export interface SimEvent {
    hour: number;
    kind: "vessel" | "rail" | "truck" | "gate" | "outage" | "info";
    text: string;
}

interface BlockSpec {
    name: string;
    rows: number;
    bays: number;
    role: string;
}

export const BLOCKS: BlockSpec[] = [
    { name: "A", rows: 8, bays: 32, role: "Import" },
    { name: "B", rows: 8, bays: 32, role: "Import" },
    { name: "C", rows: 6, bays: 28, role: "Export" },
    { name: "D", rows: 6, bays: 28, role: "Export" },
    { name: "E", rows: 5, bays: 20, role: "Rail" },
    { name: "F", rows: 4, bays: 16, role: "Technical" },
];

const VESSELS = ["MV Kestrel Bay", "MV Lumen Star", "MV Halvard", "MV Opaline", "MV Saltmarsh", "MV Brightwater"];
const VIN_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

/** mulberry32: tiny, fast, good enough for a demo. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class TerminalSim {
    hour = 0;
    rows: MockRow[] = [];
    private readonly random: () => number;
    private pendingVessel: { name: string; ids: string[]; dueHour: number } | null = null;
    private vesselIndex = 0;
    private outages = new Set<string>();

    constructor(seed = 20261013) {
        this.random = rng(seed);
        for (const block of BLOCKS) {
            for (let row = 1; row <= block.rows; row++) {
                for (let bay = 1; bay <= block.bays; bay++) {
                    const fill = block.name === "F" ? 0.45 : 0.7;
                    const occupied = this.random() < fill;
                    this.rows.push({
                        id: `${block.name}-${row}-${bay}`,
                        block: block.name,
                        row,
                        bay,
                        status: occupied ? "Occupied" : "Free",
                        // Skewed towards short stays, with a long tail past the alert.
                        dwellHours: occupied ? Math.round(Math.pow(this.random(), 3) * 110) : null,
                        unit: occupied ? this.vin() : "",
                    });
                }
            }
        }
        // A couple of slots out of service from the start, so the legend has something to show.
        for (const id of ["F-1-3", "F-1-4", "C-6-27", "C-6-28"]) this.block(this.byId(id));
    }

    get clock(): string {
        const day = Math.floor(this.hour / 24) + 1;
        return `Day ${day} · ${String(this.hour % 24).padStart(2, "0")}:00`;
    }

    /** Advance one simulated hour. Returns what happened, newest last. */
    tick(): SimEvent[] {
        this.hour++;
        const events: SimEvent[] = [];
        for (const r of this.rows) if (r.status === "Occupied" && r.dwellHours !== null) r.dwellHours++;

        if (this.pendingVessel && this.hour >= this.pendingVessel.dueHour) {
            events.push(this.discharge());
        } else if (!this.pendingVessel && this.random() < 0.12) {
            events.push(this.vesselArrives());
        }

        if (this.hour % 14 === 0) events.push(this.railDeparture());

        // Trucks pick up import cars, favouring the ones that have waited longest.
        const pickups = 2 + Math.floor(this.random() * 5);
        const picked = this.occupied(["A", "B"])
            .filter((r) => (r.dwellHours ?? 0) > 18)
            .map((r) => ({ r, score: (r.dwellHours ?? 0) * this.random() }))
            .sort((a, b) => b.score - a.score)
            .slice(0, pickups)
            .map(({ r }) => r);
        picked.forEach((r) => this.free(r));
        if (picked.length) events.push({ hour: this.hour, kind: "truck", text: `${picked.length} import cars left by truck` });

        // Export cars gate in for the next sailing.
        const gateIns = 1 + Math.floor(this.random() * 4);
        const placed = this.place(["C", "D"], gateIns);
        if (placed) events.push({ hour: this.hour, kind: "gate", text: `${placed} export cars gated in to C/D` });

        // Cars in the technical block get repaired and leave.
        const fixed = this.occupied(["F"]).filter((r) => (r.dwellHours ?? 0) > 30 && this.random() < 0.2);
        fixed.forEach((r) => this.free(r));

        return events;
    }

    vesselArrives(): SimEvent {
        if (this.pendingVessel) return { hour: this.hour, kind: "info", text: `${this.pendingVessel.name} is already on its way` };
        const name = VESSELS[this.vesselIndex++ % VESSELS.length];
        const want = 30 + Math.floor(this.random() * 40);
        const slots = this.freeSlots(["A", "B"]).slice(0, want);
        for (const r of slots) r.status = "Reserved";
        this.pendingVessel = { name, ids: slots.map((r) => r.id), dueHour: this.hour + 3 };
        return { hour: this.hour, kind: "vessel", text: `${name} announced: ${slots.length} slots reserved in A/B` };
    }

    railDeparture(): SimEvent {
        const ready = this.occupied(["E"]);
        const train = ready.slice(0, Math.min(ready.length, 40));
        train.forEach((r) => this.free(r));
        const refill = this.place(["E"], 12 + Math.floor(this.random() * 14));
        return { hour: this.hour, kind: "rail", text: `Train left with ${train.length} cars; ${refill} staged for the next one` };
    }

    toggleOutage(block: string): SimEvent {
        const rows = this.rows.filter((r) => r.block === block && r.row === 1);
        if (this.outages.has(block)) {
            this.outages.delete(block);
            rows.filter((r) => r.status === "Blocked").forEach((r) => this.free(r));
            return { hour: this.hour, kind: "outage", text: `Block ${block} row 1 back in service` };
        }
        this.outages.add(block);
        rows.filter((r) => r.status !== "Occupied").forEach((r) => this.block(r));
        return { hour: this.hour, kind: "outage", text: `Block ${block} row 1 closed (lighting fault)` };
    }

    private discharge(): SimEvent {
        const vessel = this.pendingVessel!;
        this.pendingVessel = null;
        let n = 0;
        for (const id of vessel.ids) {
            const r = this.byId(id);
            if (r.status !== "Reserved") continue;
            r.status = "Occupied";
            r.dwellHours = 0;
            r.unit = this.vin();
            n++;
        }
        return { hour: this.hour, kind: "vessel", text: `${vessel.name} discharged ${n} cars into A/B` };
    }

    private place(blocks: string[], count: number): number {
        const slots = this.freeSlots(blocks).slice(0, count);
        for (const r of slots) {
            r.status = "Occupied";
            r.dwellHours = 0;
            r.unit = this.vin();
        }
        return slots.length;
    }

    private freeSlots(blocks: string[]): MockRow[] {
        const free = this.rows.filter((r) => blocks.includes(r.block) && r.status === "Free");
        // Shuffle a little so arrivals don't always fill top-left first.
        for (let i = free.length - 1; i > 0; i--) {
            const j = Math.floor(this.random() * (i + 1));
            [free[i], free[j]] = [free[j], free[i]];
        }
        return free;
    }

    private occupied(blocks: string[]): MockRow[] {
        return this.rows.filter((r) => blocks.includes(r.block) && r.status === "Occupied");
    }

    private free(r: MockRow): void {
        r.status = "Free";
        r.dwellHours = null;
        r.unit = "";
    }

    private block(r: MockRow): void {
        r.status = "Blocked";
        r.dwellHours = null;
        r.unit = "";
    }

    private byId(id: string): MockRow {
        const r = this.rows.find((x) => x.id === id);
        if (!r) throw new Error(`Unknown slot ${id}`);
        return r;
    }

    private vin(): string {
        let s = "";
        for (let i = 0; i < 17; i++) s += VIN_CHARS[Math.floor(this.random() * VIN_CHARS.length)];
        return s;
    }
}
