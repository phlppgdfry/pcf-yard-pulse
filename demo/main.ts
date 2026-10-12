/*
 * Demo page: runs the real YardPulse control (same source as the solution
 * bundle) against MockHost, fed by the North Quay simulation.
 */
import { YardPulse } from "../YardPulse/index";
import { MockHost, MockRow } from "./mock-context";
import { BLOCKS, SimEvent, TerminalSim } from "./simulator";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const sim = new TerminalSim();
const host = new MockHost({ onOpen: showRecord, onSelect: showSelection });
host.rows = sim.rows;

const control = new YardPulse();
control.init(host.context(), () => undefined, {}, $<HTMLDivElement>("yard"));
refresh();

function refresh(): void {
    control.updateView(host.context());
    $("clock").textContent = sim.clock;
}

// Simulation loop

const SPEEDS = [1600, 500, 150];
let speed = 0;
let timer: number | undefined;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function step(): void {
    log(sim.tick());
    refresh();
}

function setPlaying(on: boolean): void {
    window.clearInterval(timer);
    timer = on ? window.setInterval(step, SPEEDS[speed]) : undefined;
    const btn = $("play");
    btn.textContent = on ? "Pause" : "Play";
    btn.setAttribute("aria-pressed", String(on));
}

$("play").addEventListener("click", () => setPlaying(timer === undefined));
$("step").addEventListener("click", step);
document.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((b) =>
    b.addEventListener("click", () => {
        speed = Number(b.dataset.speed);
        document.querySelectorAll("[data-speed]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        if (timer !== undefined) setPlaying(true);
    }),
);
document.addEventListener("visibilitychange", () => {
    if (document.hidden && timer !== undefined) setPlaying(false);
});

// Scenarios

$("vessel").addEventListener("click", () => {
    log([sim.vesselArrives()]);
    refresh();
});
$("rail").addEventListener("click", () => {
    log([sim.railDeparture()]);
    refresh();
});
const outageSelect = $<HTMLSelectElement>("outage-block");
outageSelect.replaceChildren(...BLOCKS.map((b) => new Option(`Block ${b.name} · ${b.role}`, b.name)));
$("outage").addEventListener("click", () => {
    log([sim.toggleOutage(outageSelect.value)]);
    refresh();
});

// Maker properties: these go through the manifest properties, like in the app designer.

$<HTMLSelectElement>("prop-color").addEventListener("change", (e) => {
    host.colorBy = (e.target as HTMLSelectElement).value as "status" | "dwell";
    refresh();
});
const alertInput = $<HTMLInputElement>("prop-alert");
alertInput.addEventListener("input", () => {
    host.dwellAlertHours = Number(alertInput.value);
    $("prop-alert-value").textContent = `${alertInput.value} h`;
    refresh();
});

// Event log

const ICONS: Record<SimEvent["kind"], string> = { vessel: "⚓", rail: "🚆", truck: "🚚", gate: "⇥", outage: "⚠", info: "ℹ" };

function log(events: SimEvent[]): void {
    const list = $("log");
    for (const e of events) {
        const li = document.createElement("li");
        li.dataset.kind = e.kind;
        const time = document.createElement("time");
        time.textContent = `${String(e.hour % 24).padStart(2, "0")}:00`;
        li.append(time, document.createTextNode(` ${ICONS[e.kind]} ${e.text}`));
        list.prepend(li);
    }
    while (list.children.length > 40) list.lastElementChild?.remove();
}

// What the platform would do with the control's requests

function showRecord(row: MockRow): void {
    const panel = $("record");
    $("record-title").textContent = row.unit || `Slot ${row.block}-${row.row}-${row.bay}`;
    const fields: [string, string][] = [
        ["Slot", `${row.block}-${row.row}-${row.bay}`],
        ["Status", row.status],
        ["Unit", row.unit || "–"],
        ["Dwell", row.dwellHours === null ? "–" : `${row.dwellHours} h`],
    ];
    $("record-fields").replaceChildren(
        ...fields.flatMap(([k, v]) => {
            const dt = document.createElement("dt");
            dt.textContent = k;
            const dd = document.createElement("dd");
            dd.textContent = v;
            return [dt, dd];
        }),
    );
    panel.hidden = false;
    $("record-close").focus();
}
$("record-close").addEventListener("click", () => ($("record").hidden = true));
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("record").hidden = true;
});

function showSelection(ids: string[]): void {
    $("selection").textContent = ids.length ? `${ids.length} selected` : "";
    document.querySelectorAll<HTMLButtonElement>("[data-needs-selection]").forEach((b) => (b.disabled = ids.length === 0));
}
showSelection([]);

// Theme

const root = document.documentElement;
$("theme").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
});

log([{ hour: 0, kind: "info", text: "North Quay shift started. Hover, click, double-click or use the arrow keys." }]);
if (!reducedMotion) setPlaying(true);
