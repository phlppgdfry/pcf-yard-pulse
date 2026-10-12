/* Maps a PCF dataset onto RawSlot rows through the manifest's property-set aliases. */
import { RawSlot } from "./model";

type DataSet = ComponentFramework.PropertyTypes.DataSet;

function toNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Read the dataset through the property-set aliases from the manifest. */
export function readSlots(dataset: DataSet): RawSlot[] {
    return dataset.sortedRecordIds.map((id) => {
        const record = dataset.records[id];
        // Formatted values give option set labels and lookup names, not raw ids.
        const text = (alias: string) => record.getFormattedValue(alias) || null;
        return {
            id,
            block: text("block"),
            row: toNumber(record.getValue("row")),
            bay: toNumber(record.getValue("bay")),
            status: text("status"),
            dwellHours: toNumber(record.getValue("dwellHours")),
            unit: text("unit"),
        };
    });
}
