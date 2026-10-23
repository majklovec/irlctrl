export const PAGES = [
	"login",
	"register",
	"devices",
	"profile",
	"index",
	"settings",
	"setup",
	"dashboards",
	"dashboardview",
	"dashboardadd",
] as const;

export type PageName = (typeof PAGES)[number];
