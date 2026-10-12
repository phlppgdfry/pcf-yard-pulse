import { describe, expect, it } from "vitest";
import { RawSlot, buildYard, changedSlots, dwellBucket, formatHours, normalizeStatus, snapshot } from "../YardPulse/core/model";

const slot = (over: Partial<RawSlot>): RawSlot => ({
    id: Math.random().toString(36).slice(2),
    block: "A",
    row: 1,
    bay: 1,
    status: "Occupied",
    dwellHours: 10,
    unit: "VIN1",
    ...over,
});

describe("normalizeStatus", () => {
    it.each([
        ["Free", "free"],
        ["", "free"],
        [null, "free"],
        ["Vrij", "free"],
        ["Reserved", "reserved"],
        ["Gepland", "reserved"],
        ["On hold", "blocked"],
        ["Geblokkeerd", "blocked"],
        ["Occupied", "occupied"],
        ["Ready for loading", "occupied"],
    ])("%s → %s", (label, state) => {
        expect(normalizeStatus(label)).toBe(state);
    });
});

describe("buildYard", () => {
    it("sizes blocks from the highest row and bay and sorts them naturally", () => {
        const yard = buildYard(
            [slot({ block: "B10", row: 2, bay: 5 }), slot({ block: "B2", row: 4, bay: 1 }), slot({ block: "B2", row: 1, bay: 3 })],
            72,
        );
        expect(yard.blocks.map((b) => [b.name, b.rows, b.bays])).toEqual([
            ["B2", 4, 3],
            ["B10", 2, 5],
        ]);
    });

    it("computes KPIs over usable slots only", () => {
        const yard = buildYard(
            [
                slot({ bay: 1, dwellHours: 10 }),
                slot({ bay: 2, dwellHours: 100 }),
                slot({ bay: 3, status: "Free", dwellHours: 500 }),
                slot({ bay: 4, status: "Blocked" }),
                slot({ bay: 5, status: "Reserved" }),
            ],
            72,
        );
        expect(yard.kpis).toMatchObject({ capacity: 4, occupied: 2, free: 1, blocked: 1, reserved: 1, overdue: 1, occupancyPct: 50, avgDwellHours: 55 });
    });

    it("ignores dwell on empty slots", () => {
        const yard = buildYard([slot({ status: "Free", dwellHours: 999 })], 72);
        expect(yard.kpis.overdue).toBe(0);
        expect(yard.kpis.avgDwellHours).toBeNull();
    });

    it("skips rows without a position and duplicate positions", () => {
        const yard = buildYard(
            [slot({ block: null }), slot({ row: 0 }), slot({ bay: Number.NaN }), slot({ id: "first" }), slot({ id: "dupe" })],
            72,
        );
        expect(yard.skipped).toBe(4);
        expect([...yard.blocks[0].slots.values()].map((s) => s.id)).toEqual(["first"]);
    });

    it("handles an empty dataset", () => {
        const yard = buildYard([], 72);
        expect(yard.blocks).toEqual([]);
        expect(yard.kpis.occupancyPct).toBe(0);
    });
});

describe("changedSlots", () => {
    it("is empty on the first render", () => {
        expect(changedSlots(null, buildYard([slot({})], 72)).size).toBe(0);
    });

    it("flags state, unit and overdue changes, not dwell ticking", () => {
        const before = buildYard([slot({ bay: 1 }), slot({ bay: 2 }), slot({ bay: 3, dwellHours: 70 }), slot({ bay: 4 })], 72);
        const after = buildYard(
            [slot({ bay: 1, dwellHours: 11 }), slot({ bay: 2, status: "Free" }), slot({ bay: 3, dwellHours: 73 }), slot({ bay: 4, unit: "VIN2" })],
            72,
        );
        expect([...changedSlots(snapshot(before), after)].sort()).toEqual(["A|1|2", "A|1|3", "A|1|4"]);
    });
});

describe("dwellBucket", () => {
    const yard = buildYard([slot({ bay: 1, dwellHours: 0 }), slot({ bay: 2, dwellHours: 40 }), slot({ bay: 3, dwellHours: 71 }), slot({ bay: 4, dwellHours: 72 }), slot({ bay: 5, status: "Free" })], 72);
    const buckets = [...yard.blocks[0].slots.values()].map((s) => dwellBucket(s, 72));
    it("spreads dwell over four steps and saves the last for overdue", () => {
        expect(buckets).toEqual([0, 2, 3, 4, null]);
    });
});

describe("formatHours", () => {
    it.each([
        [null, "–"],
        [5, "5 h"],
        [47.6, "48 h"],
        [60, "2.5 d"],
        [300, "13 d"],
    ])("%s → %s", (h, out) => expect(formatHours(h)).toBe(out));
});
