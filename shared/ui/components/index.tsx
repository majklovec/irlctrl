/* Shared building blocks for Mithril JSX views — one file per concern under
 * components/, re-exported here so pages and modules import from one place.
 * See shared/ui/README.md for the catalogue. */
export type { Child } from "../util";
export { Badge, type BadgeKind, ConnectionBadge } from "./badge";
export { Actions, Button, IconButton, IconLink } from "./button";
export { Card, type CardProps } from "./card";
export { type ConfirmOptions, confirmDialog } from "./confirm";
export { DefinitionList, WidgetTable } from "./data";
export {
	DynamicForm,
	type DynamicFormAttrs,
	type FieldOption,
	type FieldSchema,
	type FieldType,
	type FormFieldSchema,
	type FormSchema,
	type GroupSchema,
	getPath,
	resolve,
	setPath,
	type Translate,
} from "./dynamic_form";
export { EmptyState } from "./empty_state";
export {
	type BoundProps,
	Break,
	Checkbox,
	CheckField,
	Field,
	FieldGroup,
	Form,
	Input,
	type KeysOf,
	NumberField,
	numberAttrs,
	Options,
	Select,
} from "./form";
export { type ChartSample, type ChartSeries, LineChart } from "./linechart";
export { Modal } from "./modal";
export { Footer, Page, TitleWithBack } from "./page";
export { RowActions, Table, type TableColumn } from "./table";
export { Toast, type ToastSlot, useToast } from "./toast";
export { Toolbar } from "./toolbar";
