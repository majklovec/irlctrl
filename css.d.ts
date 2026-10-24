/* Module styles.css files are side-effect imports: Bun's bundler emits them into
 * the page (see the HTML entrypoints in api.ts / server.ts). Declaration only so
 * `tsc --noEmit` accepts the import. */
declare module "*.css";

/* Image assets import to their public URL path (hashed under /assets/); Bun's
 * bundler emits the file and rewrites the reference. */
declare module "*.png" {
	const url: string;
	export default url;
}
declare module "*.svg" {
	const url: string;
	export default url;
}
declare module "*.ico" {
	const url: string;
	export default url;
}
