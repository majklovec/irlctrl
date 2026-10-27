/* The bound core bag and the module's persisted config sections. */
import type { ModuleCore } from "../../backend/client/module-core";
import type { CeraConfig, EncoderConfig } from "./types";

/** Bound at discovery and re-bound at start; a live binding for the other files. */
export let core: ModuleCore;

export function bindCore(c: ModuleCore): void {
	core = c;
}

/** The module's sections of the config file (`core.state.data`). */
export interface EncoderData {
	/** The last used encoder config (restored by autostart and the UI form). */
	encoder?: EncoderConfig;
	/** ceracoder bitrate-control settings (only with the ceracoder encoder). */
	ceracoder?: CeraConfig;
	/** Imported GitHub pipeline repositories ("owner/repo"), sorted. */
	pipelineRepositories?: string[];
}

export const data = (): EncoderData => core.state.data as EncoderData;
