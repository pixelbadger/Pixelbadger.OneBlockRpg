/**
 * Sound in the browser. TODO(audio): silent until payloads ship sounds (docs/plans/frontend-platforms.md, phase 6).
 * The plan for this file:
 * - one AudioContext, made on the first user gesture (`resume`, which the setup screen's buttons call);
 * - `load` decodes each manifest file with `decodeAudioData` from the embedded assets into an AudioBuffer;
 * - a GainNode per bus (master → sfx, master → ambience), set from `volume` and the `volume.*` settings;
 * - `cue` plays a buffer once through the sfx bus, with a StereoPannerNode for `pan`;
 * - `ambience` crossfades the looping beds (AudioBufferSourceNode, `loop = true`) over a second or so;
 * - `dispose` closes the context.
 */
import type { AudioOut } from "../../platform/index.js";

export function webAudio(): AudioOut {
  return {
    load: async () => {},
    cue: () => {},
    ambience: () => {},
    volume: () => {},
    resume: async () => {},
    dispose: () => {},
  };
}
