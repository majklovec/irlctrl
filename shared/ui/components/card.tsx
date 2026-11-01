/** @jsx m */
import m from "mithril";
import type { MithrilJSXComponent } from "../jsx";
import type { Child } from "../util";

export interface CardProps {
	/** Bare <h2> title. Use `headActions` for the title-plus-actions row. */
	title?: Child;
	/** Actions on the right of the title row (.card-head). */
	headActions?: m.Children;
	/** Extra class(es) on the <section.card> root (module-scoped styling). */
	class?: string;
}

export const Card = {
	view: ({ attrs: { title, headActions, class: extra }, children }) => (
		<section class={extra === undefined ? "card" : `card ${extra}`}>
			{[
				title === undefined ? null : headActions === undefined ? (
					<h2>{title}</h2>
				) : (
					<div class="card-head">
						<h2>{title}</h2>
						<div class="actions">{headActions}</div>
					</div>
				),
				children, // nested arrays are flattened by mithril
			]}
		</section>
	),
} as MithrilJSXComponent<CardProps>;
