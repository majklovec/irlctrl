import { describe, expect, test } from "bun:test";
import { AudioSourceTracker } from "../modules/obs-controller/audio-sources";
import { SceneTracker } from "../modules/obs-controller/scenes";
import {
    OBS_DISCONNECTED_EVENT,
    type ObsClient,
    type ObsRequest,
    type ObsRequestBatch,
} from "../shared/obs/client";

/** Minimal ObsClient stand-in: OBS with the given inputs (null = no audio). */
function fakeObs(inputs: Record<string, boolean | null>) {
    const handlers = new Map<
        string,
        ((d: Record<string, unknown>) => void)[]
    >();
    const calls: string[] = [];
    const client = {
        identified: true,
        on(name: string, h: (d: Record<string, unknown>) => void) {
            handlers.set(name, [...(handlers.get(name) ?? []), h]);
        },
        async sendRequest(req: ObsRequest) {
            calls.push(req.requestType);
            return {
                requestType: req.requestType,
                requestId: req.requestId,
                requestStatus: { result: true, code: 100 },
                responseData: {
                    inputs: Object.keys(inputs).map((inputName) => ({
                        inputName,
                    })),
                },
            };
        },
        async sendBatch(batch: ObsRequestBatch) {
            calls.push(`batch:${batch.requests.length}`);
            return {
                requestId: batch.requestId,
                results: batch.requests.map((r) => {
                    const muted = inputs[r.requestData?.inputName as string];
                    return {
                        requestType: r.requestType,
                        requestId: r.requestId,
                        requestStatus:
                            typeof muted === "boolean"
                                ? { result: true, code: 100 }
                                : { result: false, code: 604 },
                        ...(typeof muted === "boolean"
                            ? { responseData: { inputMuted: muted } }
                            : {}),
                    };
                }),
            };
        },
    };
    const fire = (name: string, d: Record<string, unknown> = {}) => {
        for (const h of handlers.get(name) ?? []) h(d);
    };
    return { client: client as unknown as ObsClient, fire, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("AudioSourceTracker", () => {
    test("seeds every audio input on identify with one batch, skipping non-audio inputs", async () => {
        const obs = fakeObs({
            "Desktop Audio": false,
            "Mic/Aux": true,
            Camera: null,
        });
        let changes = 0;
        const t = new AudioSourceTracker(obs.client, () => changes++);
        obs.fire("CurrentProgramSceneChanged"); // replayed after identify
        await settle();
        expect(t.list()).toEqual([
            { name: "Desktop Audio", muted: false },
            { name: "Mic/Aux", muted: true },
        ]);
        expect(obs.calls).toEqual(["GetInputList", "batch:3"]);
        expect(changes).toBe(1);
        // meter ticks for known / failed inputs cost no further requests
        obs.fire("InputVolumeMeters", {
            inputs: [{ inputName: "Desktop Audio" }, { inputName: "Camera" }],
        });
        await settle();
        expect(obs.calls).toEqual(["GetInputList", "batch:3"]);
    });

    test("follows mute flips, removals and renames", async () => {
        const obs = fakeObs({ Mic: false, SRTLA: false });
        let changes = 0;
        const t = new AudioSourceTracker(obs.client, () => changes++);
        obs.fire("CurrentProgramSceneChanged");
        await settle();
        obs.fire("InputMuteStateChanged", {
            inputName: "Mic",
            inputMuted: true,
        });
        obs.fire("InputMuteStateChanged", {
            inputName: "Mic",
            inputMuted: true,
        }); // no-op
        expect(changes).toBe(2);
        obs.fire("InputNameChanged", {
            oldInputName: "Mic",
            inputName: "Voice",
        });
        expect(t.list()).toEqual([
            { name: "Voice", muted: true },
            { name: "SRTLA", muted: false },
        ]);
        obs.fire("InputRemoved", { inputName: "SRTLA" });
        expect(t.list()).toEqual([{ name: "Voice", muted: true }]);
    });

    test("clears on disconnect and re-seeds on the next identify", async () => {
        const obs = fakeObs({ Mic: false });
        const t = new AudioSourceTracker(obs.client, () => {});
        obs.fire("CurrentProgramSceneChanged");
        await settle();
        obs.fire(OBS_DISCONNECTED_EVENT);
        expect(t.list()).toEqual([]);
        obs.fire("CurrentProgramSceneChanged");
        await settle();
        expect(t.list()).toEqual([{ name: "Mic", muted: false }]);
        expect(obs.calls).toEqual([
            "GetInputList",
            "batch:1",
            "GetInputList",
            "batch:1",
        ]);
    });
});

describe("SceneTracker", () => {
    test("follows the replayed list, creations (not groups), removals, renames and drops", () => {
        const obs = fakeObs({});
        let changes = 0;
        const t = new SceneTracker(obs.client, () => changes++);
        obs.fire("SceneListChanged", {
            scenes: [{ sceneName: "Live" }, { sceneName: "BRB" }],
        });
        obs.fire("SceneListChanged", {
            scenes: [{ sceneName: "Live" }, { sceneName: "BRB" }],
        }); // unchanged → no notification
        expect(t.list()).toEqual(["Live", "BRB"]);
        expect(changes).toBe(1);
        obs.fire("SceneCreated", { sceneName: "Group", isGroup: true });
        obs.fire("SceneCreated", { sceneName: "Ending", isGroup: false });
        obs.fire("SceneNameChanged", {
            oldSceneName: "BRB",
            sceneName: "Pause",
        });
        obs.fire("SceneRemoved", { sceneName: "Live" });
        expect(t.list()).toEqual(["Pause", "Ending"]);
        obs.fire("CurrentProgramSceneChanged", { sceneName: "Pause" });
        obs.fire("SceneNameChanged", {
            oldSceneName: "Pause",
            sceneName: "BRB",
        });
        expect(t.current()).toBe("BRB");
        obs.fire(OBS_DISCONNECTED_EVENT);
        expect(t.list()).toEqual([]);
        expect(t.current()).toBeNull();
        expect(obs.calls).toEqual([]); // the client's replay seeds it, no requests
    });
});
