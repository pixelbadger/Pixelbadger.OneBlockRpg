/**
 * The web host (§3.1): the whole engine runs in the page. The scene is a canvas drawn by the shared renderer, every
 * text panel is HTML (Preact), and both feed the shared GameClient. Saves live in IndexedDB, settings in
 * localStorage; characters are played offline or through the Anthropic API with the player's own key. Bundled by
 * tools/web.ts; page.ts embeds the payload and its art.
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { GameClient } from "../../client/game-client.js";
import { SpriteSheet } from "../../client/sprites.js";
import type { Game } from "../../platform/game.js";
import { Hud } from "./hud/hud.js";
import { decodePng, type WebImage } from "./hud/scene.js";
import { Setup } from "./hud/setup.js";
import { GAME_DATA_ID, type WebGame } from "./page.js";
import { type WebPlatform, webPlatform } from "./platform.js";
import { flushOnHide } from "./save-idb.js";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Playing {
  game: Game;
  client: GameClient;
  release: () => void;
}

function App({
  data,
  platform,
  sprites,
  saveError,
}: {
  data: WebGame;
  platform: WebPlatform;
  sprites?: SpriteSheet<WebImage>;
  saveError: { listen?: (msg: string) => void };
}) {
  const { payload } = data;
  const [playing, setPlaying] = useState<Playing | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const stop = (p: Playing, why?: string) => {
    p.game.close();
    p.release();
    setNotice(why);
    setPlaying(undefined);
  };

  // A save that can't be written stops the game where it was last saved, rather than play on unsaved.
  useEffect(() => {
    saveError.listen = (msg) => (playing ? stop(playing, msg) : setNotice(msg));
  });

  useEffect(() => {
    if (!playing) return;
    const close = () => playing.game.close();
    // A page restored from the back/forward cache has a closed save: start again from the setup screen.
    const restore = (e: PageTransitionEvent) => e.persisted && location.reload();
    addEventListener("pagehide", close);
    addEventListener("pageshow", restore);
    return () => {
      removeEventListener("pagehide", close);
      removeEventListener("pageshow", restore);
    };
  }, [playing]);

  if (!playing) {
    return (
      <Setup
        payload={payload}
        platform={platform}
        key={notice}
        {...(notice ? { notice } : {})}
        onStart={(game, label, release) => {
          const client = new GameClient({
            session: game.session,
            title: payload.game.title,
            flush: game.flush,
            audio: platform.audio,
            quit: () => stop(p),
            banner: `${game.resuming ? "Resumed" : "New game"} · ${label} · saved in this browser · ? for keys`,
          });
          const p: Playing = { game, client, release };
          client.start();
          setNotice(undefined);
          setPlaying(p);
        }}
      />
    );
  }
  return <Hud client={playing.client} {...(sprites ? { sprites } : {})} />;
}

async function main(): Promise<void> {
  const root = document.getElementById("app")!;
  const data = JSON.parse(document.getElementById(GAME_DATA_ID)?.textContent ?? "{}") as WebGame;
  const saveError: { listen?: (msg: string) => void } = {};
  const platform = webPlatform({
    assets: data.assets ?? {},
    onSaveError: (err) => saveError.listen?.(`Saving failed: ${message(err)}`),
  });
  flushOnHide(platform.saves, window);
  const sprites = await SpriteSheet.load(platform.assets, decodePng);
  root.replaceChildren();
  render(<App data={data} platform={platform} saveError={saveError} {...(sprites ? { sprites } : {})} />, root);
}

main().catch((err) => {
  console.error(err);
  const p = document.createElement("p");
  p.className = "loading style-danger";
  p.textContent = `Couldn't start the game: ${message(err)}`;
  document.getElementById("app")?.replaceChildren(p);
});
