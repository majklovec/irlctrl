/* The dashboard entity pages, one linkable URL each. */
export const DASHBOARD_LIST_URL = "/dashboards/";
export const dashboardViewUrl = (id: string): string =>
	`/dashboards/view/${encodeURIComponent(id)}/`;
export const dashboardUpdateUrl = (id: string): string =>
	`/dashboards/edit/${encodeURIComponent(id)}/`;
export const dashboardAddUrl = (id: string): string =>
	`/dashboards/add/${encodeURIComponent(id)}/`;
