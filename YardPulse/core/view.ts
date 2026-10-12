/*
 * DOM renderer for the yard. Knows nothing about PCF: the control (index.ts)
 * and the demo both feed it a YardModel and listen to its callbacks.
 *
 * Cells are patched in place between renders, so a slot whose state changed
 * keeps its element and can play the pulse animation.
 */
import {
    Block,
    ColorBy,
    Slot,
    YardModel,
    changedSlots,
    dwellBucket,
    formatHours,
    matchesQuery,
    snapshot,
} from "./model";

export interface ViewCallbacks {
    /** Open the record behind a slot (double-click or Enter). */
    onOpen(recordId: string): void;
    /** The selection changed (click, Ctrl/Cmd-click or Space). */
    onSelect(recordIds: string[]): void;
}

export interface ViewOptions {
    colorBy: ColorBy;
    dwellAlertHours: number;
    selectedIds: readonly string[];
    loading?: boolean;
    /** Shown under the yard, e.g. when records were skipped or truncated. */
    notice?: string;
}

const STATE_LABEL: Record<Slot["state"], string> = {
    free: "Free",
    occupied: "Occupied",
    reserved: "Reserved",
    blocked: "Blocked",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

interface BlockView {
    signature: string;
    root: HTMLElement;
    meter: HTMLElement;
    pct: HTMLElement;
    grid: HTMLElement;
    cells: Map<string, HTMLElement>;
}

export class YardView {
    private readonly root: HTMLDivElement;
    private readonly kpiValues: Record<string, HTMLElement> = {};
    private readonly legend: HTMLElement;
    private readonly blocksHost: HTMLElement;
    private readonly empty: HTMLElement;
    private readonly notice: HTMLElement;
    private readonly tooltip: HTMLElement;
    private readonly live: HTMLElement;
    private readonly search: HTMLInputElement;
    private readonly modeButtons: Record<ColorBy, HTMLButtonElement>;

    private blockViews = new Map<string, BlockView>();
    private slotsByKey = new Map<string, Slot>();
    private previous: Map<string, string> | null = null;
    private options: ViewOptions = { colorBy: "status", dwellAlertHours: 72, selectedIds: [] };
    private colorOverride: ColorBy | null = null;
    private lastColorProp: ColorBy | null = null;
    private query = "";
    private selected = new Set<string>();
    private focusKey: string | null = null;

    constructor(container: HTMLElement, private readonly callbacks: ViewCallbacks) {
        this.root = el("div", "yp");
        container.appendChild(this.root);

        const head = el("header", "yp-head");
        const kpis = el("div", "yp-kpis");
        for (const [id, label] of [
            ["occupancy", "Occupancy"],
            ["units", "Units on yard"],
            ["dwell", "Avg dwell"],
            ["overdue", "Over alert"],
        ]) {
            const tile = el("div", `yp-kpi yp-kpi-${id}`);
            tile.append(el("span", "yp-kpi-label", label));
            const value = el("span", "yp-kpi-value", "–");
            tile.append(value);
            this.kpiValues[id] = value;
            kpis.append(tile);
        }

        const tools = el("div", "yp-tools");
        const seg = el("div", "yp-seg");
        seg.setAttribute("role", "group");
        seg.setAttribute("aria-label", "Colour slots by");
        const mkMode = (mode: ColorBy, label: string) => {
            const b = el("button", "yp-seg-btn", label);
            b.type = "button";
            b.addEventListener("click", () => {
                this.colorOverride = mode;
                this.paint();
            });
            seg.append(b);
            return b;
        };
        this.modeButtons = { status: mkMode("status", "Status"), dwell: mkMode("dwell", "Dwell") };

        this.search = el("input", "yp-search");
        this.search.type = "search";
        this.search.placeholder = "Find unit…";
        this.search.setAttribute("aria-label", "Find unit or status");
        this.search.addEventListener("input", () => {
            this.query = this.search.value;
            this.paint();
        });
        tools.append(seg, this.search);
        head.append(kpis, tools);

        this.legend = el("div", "yp-legend");
        this.blocksHost = el("div", "yp-blocks");
        this.empty = el("div", "yp-empty");
        this.notice = el("p", "yp-notice");
        this.tooltip = el("div", "yp-tip");
        this.tooltip.setAttribute("role", "tooltip");
        this.tooltip.hidden = true;
        this.live = el("div", "yp-sr");
        this.live.setAttribute("aria-live", "polite");

        this.root.append(head, this.legend, this.blocksHost, this.empty, this.notice, this.tooltip, this.live);

        this.blocksHost.addEventListener("click", this.onClick);
        this.blocksHost.addEventListener("dblclick", this.onDblClick);
        this.blocksHost.addEventListener("keydown", this.onKeyDown);
        this.blocksHost.addEventListener("mouseover", this.onHover);
        this.blocksHost.addEventListener("mouseleave", () => (this.tooltip.hidden = true));
        this.blocksHost.addEventListener("focusin", this.onFocus);
        this.blocksHost.addEventListener("focusout", () => (this.tooltip.hidden = true));
    }

    render(model: YardModel, options: ViewOptions): void {
        // A maker changing the property wins over the viewer's toggle.
        if (options.colorBy !== this.lastColorProp) {
            this.colorOverride = null;
            this.lastColorProp = options.colorBy;
        }
        this.options = options;
        this.selected = new Set(options.selectedIds);

        const changed = changedSlots(this.previous, model);
        this.previous = snapshot(model);
        this.slotsByKey = new Map();
        for (const block of model.blocks) for (const slot of block.slots.values()) this.slotsByKey.set(slot.key, slot);

        this.syncBlocks(model.blocks);
        this.paint(changed);
        this.renderKpis(model);
        this.root.classList.toggle("is-loading", !!options.loading);
        this.notice.textContent = options.notice ?? "";
        this.notice.hidden = !options.notice;

        if (changed.size) {
            this.live.textContent = `${changed.size} slot${changed.size === 1 ? "" : "s"} changed`;
        }
    }

    destroy(): void {
        this.root.remove();
        this.blockViews.clear();
    }

    private get colorBy(): ColorBy {
        return this.colorOverride ?? this.options.colorBy;
    }

    private renderKpis(model: YardModel): void {
        const k = model.kpis;
        this.kpiValues.occupancy.textContent = k.capacity ? `${k.occupancyPct}%` : "–";
        this.kpiValues.units.textContent = k.occupied.toLocaleString();
        this.kpiValues.dwell.textContent = formatHours(k.avgDwellHours);
        this.kpiValues.overdue.textContent = k.overdue.toLocaleString();
        this.kpiValues.overdue.parentElement?.classList.toggle("is-alert", k.overdue > 0);

        const total = model.blocks.reduce((n, b) => n + b.slots.size, 0);
        this.empty.hidden = total > 0;
        this.empty.textContent = this.options.loading
            ? "Loading slots…"
            : "No slots to show. Map the Block, Row, Bay and Status columns, or check the view's filter.";
    }

    /** Create, rebuild or remove block sections so they match the model. */
    private syncBlocks(blocks: Block[]): void {
        const seen = new Set<string>();
        let anchor: Element | null = null;

        for (const block of blocks) {
            seen.add(block.name);
            const signature = `${block.rows}x${block.bays}`;
            let view = this.blockViews.get(block.name);
            if (!view || view.signature !== signature) {
                const fresh = this.buildBlock(block, signature);
                if (view) view.root.replaceWith(fresh.root);
                view = fresh;
                this.blockViews.set(block.name, view);
            }
            // Keep DOM order equal to model order.
            const next: Element | null = anchor ? anchor.nextElementSibling : this.blocksHost.firstElementChild;
            if (next !== view.root) this.blocksHost.insertBefore(view.root, next);
            anchor = view.root;

            const pct = block.capacity ? Math.round((block.occupied / block.capacity) * 100) : 0;
            view.pct.textContent = `${block.occupied}/${block.capacity} · ${pct}%`;
            view.meter.style.setProperty("--fill", `${pct}%`);
        }

        for (const [name, view] of this.blockViews) {
            if (!seen.has(name)) {
                view.root.remove();
                this.blockViews.delete(name);
            }
        }
    }

    private buildBlock(block: Block, signature: string): BlockView {
        const root = el("section", "yp-block");
        root.style.setProperty("--bays", String(block.bays));

        const title = el("h3", "yp-block-title");
        title.append(el("span", "yp-block-name", `Block ${block.name}`));
        const pct = el("span", "yp-block-pct");
        title.append(pct);
        const meter = el("div", "yp-meter");
        meter.append(el("span"));

        const grid = el("div", "yp-grid");
        grid.setAttribute("role", "grid");
        grid.setAttribute("aria-label", `Block ${block.name}, ${block.rows} rows by ${block.bays} bays`);

        const cells = new Map<string, HTMLElement>();
        for (let r = 1; r <= block.rows; r++) {
            const row = el("div", "yp-row");
            row.setAttribute("role", "row");
            for (let b = 1; b <= block.bays; b++) {
                const cell = el("div", "yp-cell");
                cell.setAttribute("role", "gridcell");
                cell.tabIndex = -1;
                const key = `${block.name}|${r}|${b}`;
                cell.dataset.key = key;
                cell.dataset.block = block.name;
                cell.dataset.row = String(r);
                cell.dataset.bay = String(b);
                cell.addEventListener("animationend", () => cell.classList.remove("is-pulse"));
                cells.set(key, cell);
                row.append(cell);
            }
            grid.append(row);
        }
        root.append(title, meter, grid);
        return { signature, root, meter, pct, grid, cells };
    }

    /** Apply colours, selection, search dimming and pulses to every cell. */
    private paint(changed = new Set<string>()): void {
        const colorBy = this.colorBy;
        this.root.dataset.colorBy = colorBy;
        for (const mode of ["status", "dwell"] as ColorBy[]) {
            this.modeButtons[mode].setAttribute("aria-pressed", String(mode === colorBy));
        }
        this.renderLegend(colorBy);

        const query = this.query.trim();
        let matches = 0;

        for (const view of this.blockViews.values()) {
            let hasTabStop = false;
            for (const [key, cell] of view.cells) {
                const slot = this.slotsByKey.get(key);
                const classes = ["yp-cell"];
                if (!slot) {
                    classes.push("is-void");
                    cell.setAttribute("aria-label", `Row ${cell.dataset.row}, bay ${cell.dataset.bay}: no slot`);
                    cell.removeAttribute("aria-selected");
                } else {
                    classes.push(`s-${slot.state}`);
                    if (colorBy === "dwell") {
                        const bucket = dwellBucket(slot, this.options.dwellAlertHours);
                        if (bucket !== null) classes.push(`d-${bucket}`);
                    }
                    if (slot.overdue) classes.push("is-overdue");
                    const isSelected = this.selected.has(slot.id);
                    if (isSelected) classes.push("is-selected");
                    if (query) {
                        if (matchesQuery(slot, query)) {
                            classes.push("is-match");
                            matches++;
                        } else {
                            classes.push("is-dim");
                        }
                    }
                    cell.setAttribute("aria-label", this.describe(slot));
                    cell.setAttribute("aria-selected", String(isSelected));
                }
                // Keep a running pulse alive across repaints; restart it on a new change.
                const pulsing = changed.has(key) || cell.classList.contains("is-pulse");
                if (changed.has(key)) {
                    cell.classList.remove("is-pulse");
                    void cell.offsetWidth;
                }
                if (pulsing) classes.push("is-pulse");
                cell.className = classes.join(" ");

                const isStop = key === this.focusKey;
                cell.tabIndex = isStop ? 0 : -1;
                hasTabStop ||= isStop;
            }
            // Every grid needs exactly one tab stop.
            if (!hasTabStop) {
                const first = view.cells.values().next().value;
                if (first) first.tabIndex = 0;
            }
        }

        if (query) this.live.textContent = `${matches} slot${matches === 1 ? "" : "s"} match “${query}”`;
    }

    private renderLegend(colorBy: ColorBy): void {
        const items: [string, string][] =
            colorBy === "status"
                ? [
                      ["s-free", "Free"],
                      ["s-occupied", "Occupied"],
                      ["s-reserved", "Reserved"],
                      ["s-blocked", "Blocked"],
                      ["s-occupied is-overdue", `Over ${formatHours(this.options.dwellAlertHours)}`],
                  ]
                : [0, 1, 2, 3].map((b): [string, string] => {
                      const step = this.options.dwellAlertHours / 4;
                      return [`s-occupied d-${b}`, `${formatHours(step * b)}–${formatHours(step * (b + 1))}`];
                  }).concat([["s-occupied d-4 is-overdue", `≥ ${formatHours(this.options.dwellAlertHours)}`]]);

        const key = `${colorBy}|${this.options.dwellAlertHours}`;
        if (this.legend.dataset.key === key) return;
        this.legend.dataset.key = key;
        this.legend.replaceChildren(
            ...items.map(([cls, label]) => {
                const item = el("span", "yp-legend-item");
                const swatch = el("span", `yp-cell yp-swatch ${cls}`);
                swatch.setAttribute("aria-hidden", "true");
                item.append(swatch, document.createTextNode(label));
                return item;
            }),
        );
    }

    private describe(slot: Slot): string {
        const parts = [`Block ${slot.block}, row ${slot.row}, bay ${slot.bay}: ${slot.statusLabel || STATE_LABEL[slot.state]}`];
        if (slot.unit) parts.push(`unit ${slot.unit}`);
        if (slot.dwellHours !== null) parts.push(`on yard ${formatHours(slot.dwellHours)}${slot.overdue ? ", over alert" : ""}`);
        return parts.join(", ");
    }

    private cellFrom(event: Event): HTMLElement | null {
        const target = event.target as HTMLElement | null;
        return target?.closest<HTMLElement>(".yp-cell[data-key]") ?? null;
    }

    private showTip(cell: HTMLElement): void {
        const slot = this.slotsByKey.get(cell.dataset.key ?? "");
        if (!slot) {
            this.tooltip.hidden = true;
            return;
        }
        this.tooltip.replaceChildren(
            el("strong", undefined, slot.unit || STATE_LABEL[slot.state]),
            el("span", undefined, `Block ${slot.block} · Row ${slot.row} · Bay ${slot.bay}`),
            el("span", `yp-tip-state s-${slot.state}`, slot.statusLabel),
            ...(slot.dwellHours !== null ? [el("span", slot.overdue ? "yp-tip-alert" : undefined, `On yard ${formatHours(slot.dwellHours)}`)] : []),
        );
        this.tooltip.hidden = false;

        const host = this.root.getBoundingClientRect();
        const rect = cell.getBoundingClientRect();
        const tip = this.tooltip.getBoundingClientRect();
        let left = rect.left - host.left + rect.width / 2 - tip.width / 2;
        left = Math.max(4, Math.min(left, host.width - tip.width - 4));
        let top = rect.top - host.top - tip.height - 8;
        if (top < 0) top = rect.bottom - host.top + 8;
        this.tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }

    private toggleSelection(slot: Slot, additive: boolean): void {
        if (additive) {
            if (this.selected.has(slot.id)) this.selected.delete(slot.id);
            else this.selected.add(slot.id);
        } else {
            this.selected = this.selected.size === 1 && this.selected.has(slot.id) ? new Set() : new Set([slot.id]);
        }
        this.paint();
        this.callbacks.onSelect([...this.selected]);
    }

    private moveFocus(cell: HTMLElement): void {
        this.focusKey = cell.dataset.key ?? null;
        for (const view of this.blockViews.values()) {
            for (const c of view.cells.values()) c.tabIndex = c === cell ? 0 : -1;
        }
        cell.focus();
    }

    private onClick = (event: MouseEvent): void => {
        const cell = this.cellFrom(event);
        const slot = cell && this.slotsByKey.get(cell.dataset.key ?? "");
        if (!cell || !slot) return;
        this.moveFocus(cell);
        this.toggleSelection(slot, event.ctrlKey || event.metaKey || event.shiftKey);
    };

    private onDblClick = (event: MouseEvent): void => {
        const cell = this.cellFrom(event);
        const slot = cell && this.slotsByKey.get(cell.dataset.key ?? "");
        if (slot) this.callbacks.onOpen(slot.id);
    };

    private onHover = (event: MouseEvent): void => {
        const cell = this.cellFrom(event);
        if (cell) this.showTip(cell);
    };

    private onFocus = (event: FocusEvent): void => {
        const cell = this.cellFrom(event);
        if (cell) {
            this.focusKey = cell.dataset.key ?? null;
            this.showTip(cell);
        }
    };

    private onKeyDown = (event: KeyboardEvent): void => {
        const cell = this.cellFrom(event);
        if (!cell) return;
        const slot = this.slotsByKey.get(cell.dataset.key ?? "");

        if (event.key === "Enter" && slot) {
            event.preventDefault();
            this.callbacks.onOpen(slot.id);
            return;
        }
        if (event.key === " " && slot) {
            event.preventDefault();
            this.toggleSelection(slot, true);
            return;
        }

        const block = cell.dataset.block ?? "";
        const view = this.blockViews.get(block);
        if (!view) return;
        const rows = view.grid.children.length;
        const bays = (view.grid.firstElementChild?.children.length ?? 1);
        let row = Number(cell.dataset.row);
        let bay = Number(cell.dataset.bay);

        switch (event.key) {
            case "ArrowRight": bay = Math.min(bays, bay + 1); break;
            case "ArrowLeft": bay = Math.max(1, bay - 1); break;
            case "ArrowDown": row = Math.min(rows, row + 1); break;
            case "ArrowUp": row = Math.max(1, row - 1); break;
            case "Home": bay = 1; break;
            case "End": bay = bays; break;
            default: return;
        }
        event.preventDefault();
        const next = view.cells.get(`${block}|${row}|${bay}`);
        if (next) this.moveFocus(next);
    };
}
