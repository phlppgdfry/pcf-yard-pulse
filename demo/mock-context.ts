/*
 * A small stand-in for the PCF runtime: just the parts of Context and DataSet
 * that Yard Pulse touches. The browser demo and the tests both drive the real
 * control through it, so neither needs a Dataverse environment.
 */
import type { IInputs } from "../YardPulse/generated/ManifestTypes";

export interface MockRow {
    id: string;
    block: string;
    row: number;
    bay: number;
    status: string;
    dwellHours: number | null;
    unit: string;
}

export interface MockHooks {
    onOpen?(row: MockRow): void;
    onSelect?(ids: string[]): void;
}

type Context = ComponentFramework.Context<IInputs>;

export class MockHost {
    rows: MockRow[] = [];
    colorBy: "status" | "dwell" = "status";
    dwellAlertHours: number | null = 72;
    allocatedHeight = -1;
    loading = false;
    selected: string[] = [];
    pageSize = 25;
    refreshCount = 0;

    constructor(private readonly hooks: MockHooks = {}) {}

    /** Build a fresh context, as the platform does before each updateView. */
    context(): Context {
        const rows = new Map(this.rows.map((r) => [r.id, r]));
        const records: Record<string, unknown> = {};
        for (const row of this.rows) {
            records[row.id] = {
                getRecordId: () => row.id,
                getValue: (alias: keyof MockRow) => row[alias] ?? null,
                getFormattedValue: (alias: keyof MockRow) => (row[alias] === null || row[alias] === undefined ? "" : String(row[alias])),
                getNamedReference: () => ({ id: { guid: row.id }, name: row.unit, etn: "phg_yardslot" }),
            };
        }

        const dataset = {
            loading: this.loading,
            sortedRecordIds: this.rows.map((r) => r.id),
            records,
            columns: [],
            paging: {
                pageSize: this.pageSize,
                totalResultCount: this.rows.length,
                hasNextPage: false,
                hasPreviousPage: false,
                setPageSize: (size: number) => (this.pageSize = size),
                loadNextPage: () => undefined,
                loadPreviousPage: () => undefined,
                reset: () => undefined,
            },
            refresh: () => this.refreshCount++,
            getSelectedRecordIds: () => [...this.selected],
            setSelectedRecordIds: (ids: string[]) => {
                this.selected = [...ids];
                this.hooks.onSelect?.(this.selected);
            },
            openDatasetItem: (ref: { id: { guid: string } }) => {
                const row = rows.get(ref.id.guid);
                if (row) this.hooks.onOpen?.(row);
            },
        };

        return {
            parameters: {
                yardSlots: dataset,
                colorBy: { raw: this.colorBy },
                dwellAlertHours: { raw: this.dwellAlertHours },
            },
            mode: {
                allocatedHeight: this.allocatedHeight,
                allocatedWidth: -1,
                trackContainerResize: () => undefined,
            },
        } as unknown as Context;
    }
}
