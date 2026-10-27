/*
 * The encoder process: the `Encoder` base class (start / stop with automatic
 * restart, live bitrate changes) and the concrete encoders:
 *   Belacoder  — bitrate control through a file holding the min and max
 *                bitrate in bit/s (its -b flag)
 *   Ceracoder  — INI config (-c) with balancer tuning
 * Both take the same pipeline / SRT arguments and re-read their bitrate
 * settings on SIGHUP.
 *
 * The last used config is persisted (`data().encoder`); the live process
 * state (running flag, pid, restarts, last error) is module-local.
 */
import { basename } from "node:path";
import { t } from "../../shared/i18n";
import { errorMessage, readLines } from "../../shared/util";
import { BITRATE_FILE, CERACODER_CONF, ENCODER_BIN, IS_CERA } from "./config";
import { core, data } from "./core";
import { preparePipeline, resolvePipeline } from "./sources";
import {
	BITRATE_KBPS,
	type CeraBalancer,
	type CeraConfig,
	type EncoderConfig,
	type EncoderState,
} from "./types";

const RESTART_DELAY_MS = 2_000;
const STOP_TIMEOUT_MS = 5_000;
// The encoder logs a lot; keep the last line that looks like a problem for the UI
const ERROR_LINE = /error|fail|stall|unable|cannot|could not/i;

/** Live process state; the config half of `EncoderState` comes from `data().encoder`. */
let live: Omit<EncoderState, "config"> = { running: false };

abstract class Encoder {
	protected readonly name: string;
	private readonly supervisor = new core.Supervisor(
		"Encoder",
		RESTART_DELAY_MS,
		(code) => this.onExit(code),
	);

	constructor(protected readonly bin: string) {
		this.name = basename(bin);
	}

	/** Arguments that point the encoder at its bitrate control file. */
	protected abstract bitrateArgs(): string[];

	/** Write the bitrate control file the encoder reads at start and on SIGHUP. */
	protected abstract writeBitrateControl(
		minKbps: number,
		maxKbps: number,
	): Promise<void>;

	/** Write a control file (only printed under --dry-run). */
	protected async writeControlFile(
		path: string,
		text: string,
		preview = `\n${text}`,
	): Promise<void> {
		if (core.config.DRY_RUN) console.log(`[DRY-RUN] write ${path}:${preview}`);
		else await core.writeFileAtomic(path, text);
	}

	/** Make a running encoder re-read its bitrate settings. */
	protected reload(): void {
		const pid = this.supervisor.running ? this.supervisor.pid : undefined;
		if (pid) process.kill(pid, "SIGHUP");
	}

	status(): EncoderState {
		const config = data().encoder;
		if (this.supervisor.wanted) return { ...live, config };
		return { running: false, config, lastError: live.lastError };
	}

	/** Validate pipeline and audio settings without starting anything. */
	async validate(cfg: EncoderConfig): Promise<void> {
		await preparePipeline(await resolvePipeline(cfg.pipeline), cfg, false);
	}

	async start(cfg: EncoderConfig): Promise<EncoderState> {
		if (this.supervisor.wanted) throw new Error("encoder is already running");
		// Keep the complete draft configuration even when validation or process
		// startup fails, so the UI can restore it on the next attempt.
		data().encoder = cfg;
		live = { running: false };
		await core.saveState();
		const pipelineFile = await preparePipeline(
			await resolvePipeline(cfg.pipeline),
			cfg,
		);
		await this.writeBitrateControl(
			cfg.minBitrate ?? BITRATE_KBPS.min,
			cfg.maxBitrate ?? BITRATE_KBPS.max,
		);

		live = { running: true, startedAt: Date.now(), restarts: 0 };
		if (core.config.DRY_RUN) {
			console.log(
				`[DRY-RUN] ${this.bin} ${pipelineFile} ${cfg.host} ${cfg.port}`,
			);
			this.supervisor.markWanted();
		} else {
			try {
				await this.supervisor.start(() => this.spawn(cfg, pipelineFile));
			} catch (err: unknown) {
				const msg = `Cannot start ${this.bin}: ${errorMessage(err)}`;
				live = { running: false, lastError: msg };
				await core.saveState();
				throw new Error(msg);
			}
		}
		await core.saveState();
		return this.status();
	}

	async stop(): Promise<void> {
		await this.supervisor.stop(STOP_TIMEOUT_MS);
		live = { running: false };
		await core.saveState();
	}

	/** Change the min / max bitrate; the encoder re-reads its settings on SIGHUP. */
	async setBitrate(minKbps: number, maxKbps: number): Promise<EncoderState> {
		const cfg = data().encoder;
		if (cfg)
			data().encoder = { ...cfg, minBitrate: minKbps, maxBitrate: maxKbps };
		await this.writeBitrateControl(minKbps, maxKbps);
		this.reload();
		await core.saveState();
		return this.status();
	}

	private spawn(cfg: EncoderConfig, pipelineFile: string): Bun.Subprocess {
		const args = [
			pipelineFile,
			cfg.host,
			cfg.port,
			"-d",
			String(cfg.delay),
			...this.bitrateArgs(),
			"-l",
			String(cfg.latency),
			...(cfg.streamid ? ["-s", cfg.streamid] : []),
		];
		console.log(`Starting ${this.bin} ${args.join(" ")}`);
		const proc = Bun.spawn([this.bin, ...args], {
			stdin: "ignore",
			stdout: "inherit",
			stderr: "pipe",
		});
		live.pid = proc.pid;
		// Surface the noisy stderr in the console and keep the last problem line for the UI
		void this.pumpStderr(proc.stderr).catch(() => {});
		return proc;
	}

	private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		for await (const line of readLines(stream)) {
			console.error(`[${this.name}] ${line}`);
			if (ERROR_LINE.test(line) && live.lastError !== line) {
				live.lastError = line;
				core.logEvent("error", "Encoder", line);
				core.notifyStateChange();
			}
		}
	}

	/**
	 * The encoder exits on SRT / capture failures; keep retrying like belaUI does.
	 * The supervisor re-runs the full start sequence against the same target.
	 */
	private onExit(code: number | null): void {
		live.pid = undefined;
		if (!this.supervisor.wanted) return;
		core.logEvent(
			"warn",
			"Encoder",
			t("log.encoder_exited", { code, delay: RESTART_DELAY_MS / 1000 }),
		);
		live.restarts = (live.restarts ?? 0) + 1;
		live.lastError ??= `${this.name} exited with code ${code}`;
		core.notifyStateChange();
		console.warn(
			`${this.name} exited with code ${code}; restarting in ${RESTART_DELAY_MS / 1000}s`,
		);
		this.supervisor.scheduleRestart();
	}
}

// ----------------------------------------------------------------------
// Concrete encoders
// ----------------------------------------------------------------------
class Belacoder extends Encoder {
	protected bitrateArgs(): string[] {
		return ["-b", BITRATE_FILE];
	}

	protected writeBitrateControl(
		minKbps: number,
		maxKbps: number,
	): Promise<void> {
		const text = `${minKbps * 1000}\n${maxKbps * 1000}\n`;
		return this.writeControlFile(
			BITRATE_FILE,
			text,
			` ${text.replace(/\n/g, " ")}`,
		);
	}
}

// ceracoder (https://github.com/CERALIVE/ceracoder) takes its bitrate settings
// from an INI config (-c) and re-reads it on SIGHUP. Max bitrate and SRT
// latency live in the encoder config (belacoder uses the same values),
// everything else in the persisted ceracoder section.
const CERA_BALANCERS = ["adaptive", "fixed", "aimd"] as const;

const DEFAULT_CERA_CONFIG: CeraConfig = {
	balancer: "adaptive",
	minBitrate: 500,
	adaptive: {
		incrStep: 30,
		decrStep: 100,
		incrInterval: 500,
		decrInterval: 200,
	},
	aimd: {
		incrStep: 50,
		decrMult: 0.75,
		incrInterval: 500,
		decrInterval: 200,
	},
};

type Range = readonly [min: number, max: number];
const STEP: Range = [1, 10_000];
const INTERVAL: Range = [10, 60_000];
/** Integer bounds per tuning field; `null` marks aimd.decrMult, a fraction in (0, 1). */
const TUNING_RANGES = {
	adaptive: {
		incrStep: STEP,
		decrStep: STEP,
		incrInterval: INTERVAL,
		decrInterval: INTERVAL,
	},
	aimd: {
		incrStep: STEP,
		decrMult: null,
		incrInterval: INTERVAL,
		decrInterval: INTERVAL,
	},
} as const;

function intInRange(value: unknown, key: string, [min, max]: Range): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new Error(`${key} must be an integer between ${min} and ${max}`);
	}
	return n;
}

/**
 * Validate and merge a partial update (as sent by the UI) over the current
 * settings; returns the complete new config. Throws on invalid values.
 */
function mergeCeraConfig(current: CeraConfig, partial: unknown): CeraConfig {
	const p = (partial && typeof partial === "object" ? partial : {}) as Record<
		string,
		unknown
	>;
	if (
		p.balancer != null &&
		!CERA_BALANCERS.includes(p.balancer as CeraBalancer)
	) {
		throw new Error(`Invalid balancer: ${String(p.balancer)}`);
	}
	const merged: CeraConfig = {
		balancer: (p.balancer as CeraBalancer | undefined) ?? current.balancer,
		minBitrate:
			p.minBitrate == null
				? current.minBitrate
				: intInRange(p.minBitrate, "minBitrate", [
						BITRATE_KBPS.min,
						BITRATE_KBPS.max,
					]),
		adaptive: { ...current.adaptive },
		aimd: { ...current.aimd },
	};

	for (const group of ["adaptive", "aimd"] as const) {
		const update = p[group];
		if (update == null) continue;
		if (typeof update !== "object")
			throw new Error(`${group} must be an object`);
		const target = merged[group] as unknown as Record<string, number>;
		for (const [key, range] of Object.entries(TUNING_RANGES[group])) {
			const value = (update as Record<string, unknown>)[key];
			const name = `${group}.${key}`;
			if (range) {
				if (value !== undefined) target[key] = intInRange(value, name, range);
				continue;
			}
			const n = value === undefined ? target[key] : Number(value);
			if (!Number.isFinite(n) || n <= 0 || n >= 1) {
				throw new Error(`${name} must be a number between 0 and 1 (exclusive)`);
			}
			target[key] = n;
		}
	}
	return merged;
}

/** Render the INI config as ceracoder's -c flag consumes it. */
function ceraConfText(
	cfg: CeraConfig,
	maxBitrate: number,
	latency: number,
): string {
	const section = (name: string, values: Record<string, number | string>) => [
		`[${name}]`,
		...Object.entries(values).map(([k, v]) => `${k} = ${v}`),
		"",
	];
	// Fixed key order (the persisted config sorts keys alphabetically)
	const tuning = (group: "adaptive" | "aimd") =>
		Object.fromEntries(
			Object.keys(TUNING_RANGES[group]).map((k) => [
				k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
				(cfg[group] as unknown as Record<string, number>)[k],
			]),
		);
	return [
		"# Generated by irlctrl — do not hand-edit (use the control UI)",
		"",
		...section("general", {
			min_bitrate: cfg.minBitrate,
			max_bitrate: maxBitrate,
			balancer: cfg.balancer,
		}),
		...section("srt", { latency }),
		...section("adaptive", tuning("adaptive")),
		...section("aimd", tuning("aimd")),
	].join("\n");
}

/** Persisted ceracoder bitrate-control settings (defaults applied). */
const ceraConfig = (): CeraConfig => data().ceracoder ?? DEFAULT_CERA_CONFIG;

class Ceracoder extends Encoder {
	/** Validate and persist a partial settings update, rewrite the INI and reload a running encoder. */
	async update(partial: unknown): Promise<CeraConfig> {
		const next = mergeCeraConfig(ceraConfig(), partial);
		data().ceracoder = next;
		await this.writeBitrateControl(
			next.minBitrate,
			data().encoder?.maxBitrate ?? 5000,
		);
		this.reload();
		await core.saveState();
		return next;
	}

	override setBitrate(minKbps: number, maxKbps: number) {
		// The INI reads the min from the persisted ceracoder section; keep it in sync
		data().ceracoder = { ...ceraConfig(), minBitrate: minKbps };
		return super.setBitrate(minKbps, maxKbps);
	}

	protected bitrateArgs(): string[] {
		return ["-c", CERACODER_CONF];
	}

	/** The min comes from the ceracoder section, the latency from the encoder config. */
	protected writeBitrateControl(
		_minKbps: number,
		maxKbps: number,
	): Promise<void> {
		const latency = data().encoder?.latency ?? 2000;
		return this.writeControlFile(
			CERACODER_CONF,
			ceraConfText(ceraConfig(), maxKbps, latency),
		);
	}
}

// ----------------------------------------------------------------------
// The device's encoder
// ----------------------------------------------------------------------
let instance: Encoder | null = null;

/**
 * The device's encoder, created lazily so the first access — from a method,
 * the status build or autostart — works without a separate startup call.
 * The core bag is bound at discovery, so this works even while the module is
 * disabled (it simply reports a stopped state).
 */
export function encoder(): Encoder {
	if (!instance)
		instance = IS_CERA
			? new Ceracoder(ENCODER_BIN)
			: new Belacoder(ENCODER_BIN);
	return instance;
}

/** The encoder when it is ceracoder (its bitrate control is configurable), else null. */
export const ceracoder = (): Ceracoder | null => {
	const enc = encoder();
	return enc instanceof Ceracoder ? enc : null;
};

/** Persisted ceracoder settings, or null when the encoder is not ceracoder. */
export const ceracoderConfig = (): CeraConfig | null =>
	IS_CERA ? ceraConfig() : null;

/** Stop the encoder if one was ever created (shutdown path). */
export async function stopEncoder(): Promise<void> {
	if (instance) await instance.stop();
}
