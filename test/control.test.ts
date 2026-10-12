// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { YardPulse } from "../YardPulse/index";
import { MockHost, MockRow } from "../demo/mock-context";

const row = (id: string, bay: number, over: Partial<MockRow> = {}): MockRow => ({
    id,
    block: "A",
    row: 1,
    bay,
    status: "Occupied",
    dwellHours: 5,
    unit: `VIN${id}`,
    ...over,
});

function mount(rows: MockRow[]) {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    const host = new MockHost({ onOpen, onSelect });
    host.rows = rows;
    const container = document.createElement("div");
    document.body.append(container);
    const control = new YardPulse();
    control.init(host.context(), () => undefined, {}, container);
    control.updateView(host.context());
    const cell = (key: string) => container.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
    return { host, container, control, cell, onOpen, onSelect };
}

describe("YardPulse control", () => {
    beforeEach(() => document.body.replaceChildren());

    it("asks for one big page on init", () => {
        const { host } = mount([row("1", 1)]);
        expect(host.pageSize).toBe(5000);
        expect(host.refreshCount).toBe(1);
    });

    it("renders one cell per position, including gaps", () => {
        const { container, cell } = mount([row("1", 1), row("3", 3, { status: "Reserved" })]);
        expect(container.querySelectorAll('[role="gridcell"]')).toHaveLength(3);
        expect(cell("A|1|1").classList).toContain("s-occupied");
        expect(cell("A|1|2").classList).toContain("is-void");
        expect(cell("A|1|3").classList).toContain("s-reserved");
        expect(container.querySelector(".yp-kpi-occupancy .yp-kpi-value")?.textContent).toBe("50%");
    });

    it("opens the record on double-click and Enter", () => {
        const { cell, onOpen } = mount([row("1", 1), row("2", 2)]);
        cell("A|1|1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        cell("A|1|2").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(onOpen.mock.calls.map(([r]) => r.id)).toEqual(["1", "2"]);
    });

    it("selects on click and adds with Ctrl-click", () => {
        const { cell, onSelect } = mount([row("1", 1), row("2", 2)]);
        cell("A|1|1").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        cell("A|1|2").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
        expect(onSelect).toHaveBeenLastCalledWith(["1", "2"]);
        expect(cell("A|1|2").getAttribute("aria-selected")).toBe("true");
    });

    it("pulses only the slots that changed", () => {
        const { host, control, cell } = mount([row("1", 1), row("2", 2)]);
        host.rows[1].status = "Free";
        host.rows[0].dwellHours = 6;
        control.updateView(host.context());
        expect(cell("A|1|1").classList).not.toContain("is-pulse");
        expect(cell("A|1|2").classList).toContain("is-pulse");
    });

    it("moves focus with the arrow keys", () => {
        const { cell } = mount([row("1", 1), row("2", 2)]);
        cell("A|1|1").focus();
        cell("A|1|1").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        expect(document.activeElement).toBe(cell("A|1|2"));
        expect(cell("A|1|1").tabIndex).toBe(-1);
    });

    it("follows the colorBy property and the dwell alert", () => {
        const { host, control, container, cell } = mount([row("1", 1, { dwellHours: 30 })]);
        host.colorBy = "dwell";
        host.dwellAlertHours = 24;
        control.updateView(host.context());
        expect(container.querySelector(".yp")?.getAttribute("data-color-by")).toBe("dwell");
        expect(cell("A|1|1").classList).toContain("is-overdue");
        expect(cell("A|1|1").classList).toContain("d-4");
    });

    it("says why records are missing", () => {
        const { container } = mount([row("1", 1), row("2", 1)]);
        expect(container.querySelector(".yp-notice")?.textContent).toMatch(/1 record skipped/);
    });
});
