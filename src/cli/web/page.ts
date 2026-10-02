/** The browser page for `oneblock serve`: xterm.js with its image addon, wired to the game over a WebSocket. */

const html = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function page(title: string, gameId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<link rel="stylesheet" href="xterm/xterm.css">
<style>
  html, body { margin: 0; height: 100%; background: #08080a; color: #aaa; font: 13px system-ui, sans-serif; }
  #term { position: absolute; inset: 0 0 22px 0; padding: 6px; }
  #bar { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; line-height: 22px; padding: 0 10px; }
  #bar a { color: #7fbfdf; }
</style>
</head>
<body>
<div id="term"></div>
<div id="bar"><span id="state">connecting…</span> · <a href="?new=1">new game</a></div>
<script src="xterm/xterm.js"></script>
<script src="xterm/addon-fit.js"></script>
<script src="xterm/addon-image.js"></script>
<script>
(() => {
  const key = "oneblock:" + ${JSON.stringify(gameId)};
  const params = new URLSearchParams(location.search);
  let id = null;
  try {
    if (!params.has("new")) id = localStorage.getItem(key);
  } catch {}
  if (!id) id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 36);
  try { localStorage.setItem(key, id); } catch {}
  if (params.has("new")) history.replaceState(null, "", location.pathname);

  const term = new Terminal({
    fontFamily: 'Menlo, "DejaVu Sans Mono", "Cascadia Mono", Consolas, monospace',
    fontSize: 15,
    theme: { background: "#08080a" },
    allowProposedApi: true,
    scrollback: 0,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new ImageAddon.ImageAddon({ sixelSupport: false, iipSupport: true, storageLimit: 64 }));
  term.open(document.getElementById("term"));
  fit.fit();
  term.focus();

  const state = document.getElementById("state");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = proto + "//" + location.host + location.pathname.replace(/[^/]*$/, "") + "play?game=" + encodeURIComponent(id)
    + "&cols=" + term.cols + "&rows=" + term.rows;
  const ws = new WebSocket(url);
  ws.onopen = () => { state.textContent = "playing (game " + id.slice(0, 8) + ")"; };
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = (e) => {
    state.textContent = "disconnected" + (e.reason ? ": " + e.reason : "") + " (reload to resume)";
    term.write("\\x1b[0m\\r\\n");
  };
  const send = (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  term.onData((d) => send({ t: "in", d }));
  term.onResize(({ cols, rows }) => send({ t: "size", cols, rows }));
  addEventListener("resize", () => fit.fit());
})();
</script>
</body>
</html>
`;
}
