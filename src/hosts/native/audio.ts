/**
 * Sound out through SDL. TODO(audio): silent until payloads ship sounds (docs/plans/frontend-platforms.md, phase 6).
 * The plan: open one playback device with `sdl.audio.openDevice(sdl.audio.devices.find(d => d.type === "playback"),
 * { format: "f32", channels: 2, frequency: 48000 })`; decode each sound in the manifest once to Float32 PCM (a WAV/OGG
 * decoder in JS or WASM); mix the playing cues and the looping ambience beds, each bus at its volume, and keep the
 * device's queue about 50 ms ahead with `device.enqueue(buffer)` from a timer (watching `device.queued`);
 * `device.play()` on resume and `device.close()` on dispose.
 */
import { type AudioOut, silentAudio } from "../../platform/index.js";

export function sdlAudio(): AudioOut {
  return { ...silentAudio };
}
