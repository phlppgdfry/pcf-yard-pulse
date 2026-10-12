import { IInputs, IOutputs } from "./generated/ManifestTypes";
import { ColorBy, buildYard } from "./core/model";
import { readSlots } from "./core/dataset";
import { YardView } from "./core/view";

type DataSet = ComponentFramework.PropertyTypes.DataSet;

/** One page large enough for a typical terminal; beyond this we say so instead of paging. */
const PAGE_SIZE = 5000;
const DEFAULT_ALERT_HOURS = 72;

export class YardPulse implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private view: YardView;
    private container: HTMLDivElement;
    private dataset: DataSet;

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        this.container = container;
        context.mode.trackContainerResize(true);

        this.view = new YardView(container, {
            onOpen: (id) => {
                const record = this.dataset?.records[id];
                if (record) this.dataset.openDatasetItem(record.getNamedReference());
            },
            onSelect: (ids) => this.dataset?.setSelectedRecordIds(ids),
        });

        const dataset = context.parameters.yardSlots;
        if (dataset.paging.pageSize !== PAGE_SIZE) {
            dataset.paging.setPageSize(PAGE_SIZE);
            dataset.refresh();
        }
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        const dataset = context.parameters.yardSlots;
        this.dataset = dataset;

        const height = context.mode.allocatedHeight;
        this.container.style.height = height > 0 ? `${height}px` : "";

        const alert = context.parameters.dwellAlertHours.raw;
        const dwellAlertHours = alert !== null && alert > 0 ? alert : DEFAULT_ALERT_HOURS;
        const colorBy: ColorBy = context.parameters.colorBy.raw === "dwell" ? "dwell" : "status";

        const model = buildYard(readSlots(dataset), dwellAlertHours);
        const notices: string[] = [];
        if (dataset.paging.hasNextPage) notices.push(`Showing the first ${PAGE_SIZE.toLocaleString()} slots. Narrow the view to see the rest.`);
        if (model.skipped) notices.push(`${model.skipped} record${model.skipped === 1 ? "" : "s"} skipped: missing block, row or bay, or a duplicate position.`);

        this.view.render(model, {
            colorBy,
            dwellAlertHours,
            selectedIds: dataset.getSelectedRecordIds(),
            loading: dataset.loading,
            notice: notices.join(" "),
        });
    }

    public getOutputs(): IOutputs {
        return {};
    }

    public destroy(): void {
        this.view?.destroy();
    }
}
