/**
 * The HUD's stylesheet. Every colour, size and space is a theme token (`--ob-*`, from themeCss), so the page looks
 * like the native host, which paints the same layout from the same tokens:
 *
 * - Left column: the scene on top (the rest of the height), the log beneath (30%, newest at the foot, the hint under
 *   it). Right column, 34 characters wide: the title, the status panel, then the fight's roster or the pack.
 * - Menus, conversation options, overlays, character creation and the ending float centred over the scene.
 * - Panels: a 1px border, panel fill. Under 700px wide: scene, then log, then the side panel, stacked.
 */

const BASE = `
:root { color-scheme: dark; }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--ob-background); color: var(--ob-text); font-family: var(--ob-font);
  font-size: var(--ob-size); line-height: var(--ob-line); }
button, input { font: inherit; color: inherit; }
a { color: var(--ob-cyan); }
.panel { background: var(--ob-panel); border: 1px solid var(--ob-border); }
`;

export const INDEX_CSS = `${BASE}
main { max-width: 48ch; margin: var(--ob-space-6) auto; padding: var(--ob-space-4); }
h1 { margin: 0 0 var(--ob-space-3); font-size: var(--ob-size-large); }
ul { margin: 0; padding-left: var(--ob-space-4); }
li { margin: var(--ob-space-2) 0; }
`;

export const HUD_CSS = `${BASE}
#app { height: 100%; }
.loading { margin: 0; padding: var(--ob-space-4); }
p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.blank { min-height: calc(var(--ob-line) * 1em); }

.button { padding: var(--ob-space-1) var(--ob-space-3); background: var(--ob-panel); border: 1px solid var(--ob-border);
  cursor: pointer; }
.button:hover, .button:focus-visible { border-color: var(--ob-border-active); outline: none; }
.button.primary { background: var(--ob-selection); color: var(--ob-selection-text); border-color: var(--ob-selection); }
.button:disabled { opacity: 0.5; cursor: default; }

/* Play. */
.game { display: flex; height: 100%; gap: var(--ob-space-2); padding: var(--ob-space-2); }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--ob-space-2); }
.scene { flex: 1; min-height: 0; position: relative; overflow: hidden; background: var(--ob-background); }
.scene.fight { border-color: var(--ob-style-danger); }
.scene canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: pointer; }
.log { flex: none; height: 30%; display: flex; flex-direction: column; }
.log .lines { flex: 1; min-height: 0; overflow-y: auto; padding: var(--ob-space-1) var(--ob-space-2); }
.log .prompt { flex: none; padding: var(--ob-space-1) var(--ob-space-2); border-top: 1px solid var(--ob-border);
  font-size: var(--ob-size-small); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.side { flex: none; width: calc(34ch + 2 * var(--ob-space-3) + 2px); overflow-y: auto;
  padding: var(--ob-space-2) var(--ob-space-3); display: flex; flex-direction: column; gap: var(--ob-space-3); }
.side h1 { margin: 0; font-size: var(--ob-size-large); }
.side h2 { margin: 0 0 var(--ob-space-1); font-size: var(--ob-size); }
.side section + section { padding-top: var(--ob-space-2); border-top: 1px solid var(--ob-border); }
.gauge { display: grid; grid-template-columns: 3ch 1fr 8ch; gap: var(--ob-space-2); align-items: center; }
.gauge .value { text-align: right; }
.bar { height: var(--ob-space-2); background: var(--ob-bar-track); }
.bar > div { height: 100%; }
.roster li { display: grid; grid-template-columns: 2ch 1fr auto; gap: var(--ob-space-1); }
.side ul { list-style: none; margin: 0; padding: 0; }

/* Floating over the scene. */
.scrim { position: absolute; inset: 0; background: var(--ob-scrim); }
.float { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: max-content; min-width: min(32ch, calc(100% - 2 * var(--ob-space-3)));
  max-width: min(80ch, calc(100% - 2 * var(--ob-space-3))); max-height: calc(100% - 2 * var(--ob-space-3));
  display: flex; flex-direction: column; background: var(--ob-overlay); border: 1px solid var(--ob-border); }
.float h2 { flex: none; margin: 0; padding: var(--ob-space-2) var(--ob-space-3); font-size: var(--ob-size-large);
  border-bottom: 1px solid var(--ob-border); }
.float .body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--ob-space-2) var(--ob-space-3); }
.float .foot { flex: none; display: flex; gap: var(--ob-space-2); align-items: center; justify-content: flex-end;
  padding: var(--ob-space-2) var(--ob-space-3); border-top: 1px solid var(--ob-border); }
.float .foot .spacer { flex: 1; }
.rows { list-style: none; margin: 0; padding: var(--ob-space-1) 0; overflow-y: auto; }
.rows .row { display: flex; width: 100%; gap: var(--ob-space-2); padding: 0 var(--ob-space-3); text-align: left;
  background: none; border: 0; cursor: pointer; }
.rows .row:hover { background: var(--ob-panel); }
.rows .selected, .rows .selected:hover { background: var(--ob-selection); color: var(--ob-selection-text); }
.rows .selected span { color: inherit; }
.rows .detail { margin-left: auto; padding-left: var(--ob-space-3); }
.allot li { display: flex; align-items: center; gap: var(--ob-space-1); padding-right: var(--ob-space-3); }
.allot .row { flex: 1; }
.allot .value { width: 3ch; text-align: center; }
.allot .button { padding: 0 var(--ob-space-2); color: var(--ob-text); }

/* Before play. */
.setup { min-height: 100%; display: flex; align-items: center; justify-content: center; padding: var(--ob-space-4); }
.setup form { width: 100%; max-width: 64ch; padding: var(--ob-space-4); display: flex; flex-direction: column;
  gap: var(--ob-space-4); }
.setup h1 { margin: 0; font-size: var(--ob-size-large); }
.setup fieldset { margin: 0; padding: var(--ob-space-2) var(--ob-space-3); border: 1px solid var(--ob-border);
  display: flex; flex-direction: column; gap: var(--ob-space-2); }
.setup legend { padding: 0 var(--ob-space-1); }
.setup label { display: flex; gap: var(--ob-space-2); align-items: center; }
.setup label.field { flex-direction: column; align-items: stretch; gap: var(--ob-space-1); }
.setup input[type=text], .setup input[type=password] { padding: var(--ob-space-1) var(--ob-space-2);
  background: var(--ob-background); border: 1px solid var(--ob-border); }
.setup input:focus { outline: none; border-color: var(--ob-border-active); }
.setup input[type=radio], .setup input[type=checkbox] { accent-color: var(--ob-selection); margin: 0; }
.slots { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--ob-space-2); }
.slots li { display: flex; gap: var(--ob-space-2); align-items: center; }
.slots .what { flex: 1; min-width: 0; }
.setup .actions { display: flex; gap: var(--ob-space-2); }

@media (max-width: 700px) {
  html, body, #app { height: auto; min-height: 100%; }
  .game { flex-direction: column; height: auto; }
  .main { flex: none; height: 90vh; }
  .side { width: auto; }
}
`;
