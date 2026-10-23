/* First-run setup wizard — shared language, identity and control steps plus
 * setup contributions registered by the device modules. */
import m from "mithril";
import { errorMessage } from "../../shared/util";
import { DEFAULT_COLOR, HOSTNAME_RE } from "../../shared/validate";
import type { Role, SetupInfo } from "../types";
import { roleCardIcon } from "./components/icons";
import {
	Actions,
	Break,
	Button,
	Checkbox,
	CheckField,
	ConnectionBadge,
	Field,
	Form,
	Input,
	Page,
	Select,
} from "./components/ui";
import { languageOptions, setLanguage, t } from "./i18n";
import type { ModuleSetupStep } from "./module-contracts";
import { setupStepsForRole } from "./module-registry";
import { RpcClient, socketUrl } from "./services/rpc";
import { HOSTNAME_PATTERN, mountPage, setHeaderColor } from "./util";

interface WizardStep {
	id: string;
	title: string;
	subtitle: string;
	valid(): boolean;
	render(): m.Children;
}

interface CoreStep {
	id: "language" | "role" | "identity" | "control" | "finish";
	title: string;
	subtitle: string;
}

const CORE_STEPS: CoreStep[] = [
	{
		id: "language",
		title: "ui.language_label",
		subtitle: "setup.step.language_sub",
	},
	{ id: "role", title: "set.role", subtitle: "setup.step.role_sub" },
	{
		id: "identity",
		title: "setup.step.identity",
		subtitle: "setup.step.identity_sub",
	},
	{
		id: "control",
		title: "setup.step.control",
		subtitle: "setup.step.control_sub",
	},
];
const FINISH_STEP: CoreStep = {
	id: "finish",
	title: "setup.step.review",
	subtitle: "setup.save",
};

const state = {
	connected: false,
	loaded: false,
	current: 0,
	message: "",
	saving: false,
	info: null as SetupInfo | null,
};

const f = {
	language: "en",
	role: undefined as Role | undefined,
	hostname: "",
	color: DEFAULT_COLOR,
	remoteUrl: "",
	remoteToken: "",
	autostart: false,
};

const stepFrame = (
	id: string,
	heading: string,
	subtitle: string,
	...children: m.Children[]
) => (
	<fieldset class="wizard-step" data-step={id}>
		<h2 class="wiz-heading">{heading}</h2>
		<p class="wiz-desc">{subtitle}</p>
		{children}
	</fieldset>
);

const roleCard = (value: Role, name: string, tagline: string): m.Vnode => (
	<label class="role-card">
		<input
			type="radio"
			name="role"
			value={value}
			required={true}
			checked={f.role === value}
			onchange={() => (f.role = value)}
		/>
		{roleCardIcon(value)}
		<span class="role-name">{name}</span>
		<span class="role-tagline">{tagline}</span>
		<img src={`/img/${value}.svg`} alt="" aria-hidden="true" />
	</label>
);

function moduleStep(step: ModuleSetupStep, role: Role): WizardStep {
	return {
		id: step.id,
		title: step.title,
		subtitle: step.subtitle,
		valid: () => step.isValid(role),
		render: () => {
			const info = state.info;
			if (!info) throw new Error("Setup data is not available");
			return stepFrame(
				step.id,
				t(step.title),
				t(step.subtitle),
				step.render(role, info),
			);
		},
	};
}

function coreStep(step: CoreStep): WizardStep {
	return {
		...step,
		valid: () => {
			switch (step.id) {
				case "role":
					return !!f.role;
				case "identity":
					return HOSTNAME_RE.test(f.hostname);
				default:
					return true;
			}
		},
		render: () => {
			switch (step.id) {
				case "language":
					return stepFrame(
						step.id,
						t("ui.language_label"),
						t("setup.language_desc"),
						<Field
							label={t("ui.language_label")}
							control={
								<Select
									target={f}
									prop="language"
									onChange={(v) => setLanguage(v)}
								>
									{languageOptions()}
								</Select>
							}
						/>,
					);
				case "role":
					return stepFrame(
						step.id,
						t("set.role"),
						t("setup.step.role_sub"),
						roleCard(
							"encoder",
							t("setup.role.encoder"),
							t("setup.role.encoder_tag"),
						),
						roleCard("relay", t("setup.step.relay"), t("setup.role.relay_tag")),
						roleCard(
							"combined",
							t("setup.role.combined"),
							t("setup.role.combined_tag"),
						),
					);
				case "identity":
					return stepFrame(
						step.id,
						t("setup.identity"),
						t("setup.identity_desc"),
						<Field
							label={t("setup.hostname")}
							control={
								<Input
									target={f}
									prop="hostname"
									required={true}
									pattern={HOSTNAME_PATTERN}
									title={t("setup.hostname_title")}
								/>
							}
						/>,
						<Field
							label={t("set.color")}
							control={
								<Input
									target={f}
									prop="color"
									type="color"
									onChange={(v) => setHeaderColor(v)}
								/>
							}
						/>,
					);
				case "control":
					return stepFrame(
						step.id,
						t("setup.step.control"),
						t("setup.control_desc"),
						<Field
							label={t("set.remote_url")}
							control={
								<Input
									target={f}
									prop="remoteUrl"
									placeholder="wss://control.example/device"
								/>
							}
						/>,
						<Field
							label={t("setup.control_token")}
							control={
								<Input
									target={f}
									prop="remoteToken"
									type="password"
									autocomplete="off"
								/>
							}
						/>,
					);
				case "finish":
					return stepFrame(
						step.id,
						t("setup.step.review"),
						t("setup.review_desc"),
						<CheckField
							label={t("setup.autostart")}
							control={<Checkbox target={f} prop="autostart" />}
						/>,
					);
			}
		},
	};
}

function visibleSteps(): WizardStep[] {
	const role = f.role;
	const modules = role
		? setupStepsForRole(role).map((s) => moduleStep(s, role))
		: [];
	return [...CORE_STEPS.map(coreStep), ...modules, coreStep(FINISH_STEP)];
}

const currentIndex = () => Math.min(state.current, visibleSteps().length - 1);

function goNext(): void {
	const steps = visibleSteps();
	const current = currentIndex();
	if (steps[current]?.valid())
		state.current = Math.min(current + 1, steps.length - 1);
}

function goPrev(): void {
	state.current = Math.max(currentIndex() - 1, 0);
}

const rpc = new RpcClient(() => socketUrl("ws"));
rpc.on("open", async () => {
	state.connected = true;
	m.redraw();
	try {
		const info = await rpc.call<SetupInfo>("setup.get");
		if (!info.required) {
			location.replace("./");
			return;
		}
		state.info = info;
		Object.assign(f, {
			hostname: info.hostname,
			color: info.color,
			language: info.language,
		});
		setLanguage(info.language);
		setHeaderColor(info.color);
		state.loaded = true;
	} catch (error: unknown) {
		state.message = errorMessage(error);
	}
	m.redraw();
});
rpc.on("close", () => {
	state.connected = false;
	m.redraw();
});

async function complete(): Promise<void> {
	const role = f.role;
	if (!role) {
		state.message = t("setup.step.role_sub");
		return;
	}
	state.saving = true;
	state.message = "";
	const payload: Record<string, unknown> = {
		language: f.language,
		role,
		hostname: f.hostname,
		color: f.color,
		remoteUrl: f.remoteUrl,
		remoteToken: f.remoteToken,
		autostart: f.autostart,
	};
	for (const setupStep of setupStepsForRole(role))
		Object.assign(payload, setupStep.config(role));
	try {
		await rpc.call("setup.complete", payload);
		state.message = `${t("setup.saved")} ${t("setup.restart_required")}`;
		rpc.reconnect();
	} catch (error: unknown) {
		state.message = errorMessage(error);
	} finally {
		state.saving = false;
		m.redraw();
	}
}

function wizard(): m.Children {
	const steps = visibleSteps();
	const current = currentIndex();
	const last = current === steps.length - 1;
	const stage = (i: number) =>
		i < current ? "done" : i === current ? "current" : "upcoming";
	return [
		<ol class="wizard-stepper">
			{steps.map((s, i) => (
				<li key={s.id} class={`wiz-item ${stage(i)}`} data-step={s.id}>
					<span class="wiz-dot">{i < current ? "✓" : String(i + 1)}</span>
					<span class="wiz-title">{t(s.title)}</span>
					<span class="wiz-sub">{t(s.subtitle)}</span>
				</li>
			))}
		</ol>,
		<Form id="setup-form" onSubmit={() => void complete()}>
			{steps[current].render()}
			<Break />
			<Actions>
				<Button
					label={t("ui.back")}
					class="secondary"
					hidden={current === 0}
					onclick={goPrev}
				/>
				<Button label={t("ui.next")} hidden={last} onclick={goNext} />
				<Button
					label={t("setup.save")}
					type="submit"
					hidden={!last}
					disabled={state.saving}
				/>
			</Actions>
		</Form>,
		<p class="muted" role="status">
			{state.message}
		</p>,
	];
}

const App: m.Component = {
	view: () => (
		<Page
			title={t("setup.title")}
			headerRight={<ConnectionBadge connected={state.connected} />}
		>
			<section class="card">
				{state.loaded ? wizard() : <p class="muted">{t("setup.loading")}</p>}
			</section>
		</Page>
	),
};

void mountPage(() => t("setup.title"), App);
