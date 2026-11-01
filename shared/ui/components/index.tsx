/* Shared building blocks for Mithril JSX views — one file per concern under
 * components/, re-exported here so pages and modules import from one place.
 * See shared/ui/README.md for the catalogue. */
export type { Child } from "../util";
export { Badge, type BadgeKind, ConnectionBadge } from "./badge";
export { Actions, Button, IconButton, IconLink } from "./button";
export { Card, type CardProps } from "./card";
export { confirmDialog, type ConfirmOptions } from "./confirm";
export { DefinitionList, WidgetTable } from "./data";
export { EmptyState } from "./empty_state";
export {
	type BoundProps,
	Break,
	CheckField,
	Checkbox,
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
export { Modal } from "./modal";
export { ServerNav } from "./nav";
export { Footer, Page, TitleWithBack } from "./page";
export { RowActions, Table, type TableColumn } from "./table";
export { Toast, type ToastSlot, useToast } from "./toast";
export { Toolbar } from "./toolbar";
