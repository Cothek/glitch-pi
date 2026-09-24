#!/usr/bin/env node
/**
 * pi-plugin-reload.mjs — make a freshly installed pi-web-ui plugin load without a
 * server restart.
 *
 * WHY: the host only scans $HOME/.pi-web/plugins on WebSocket attach or on the
 * `plugins_reload` message (the "重新加载" button in Settings -> 界面插件 sends it).
 * The web server also hosts the agent session you are likely running inside, so a
 * restart kills the very turn doing the work. This sends one websocket hello plus
 * `plugins_reload` and prints the resulting roster entry, so the new code is live
 * without stopping anything.
 *
 * USAGE: node scripts/pi-plugin-reload.mjs [pluginId] [port]
 *
 * Requires the local instance on the given port (default 8787). `ws` is resolved
 * from pi-web-ui's own node_modules, so this repo needs no dependency.
 */

const PLUGIN_ID = process.argv[2] ?? null;
const PORT = Number(process.argv[3] ?? 8787);

const { default: WebSocket } = await import(
	"file:///E:/Glitch%20AI/glitch-pi/data/node/node_modules/pi-web-ui/node_modules/ws/index.js"
);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
	headers: { "user-agent": "glitch-plugin-reload/1.0" }, // rule 4: no Origin header = admitted
});

let sent = false;
/** The epoch carried by the attach-time plugins snapshot; the reload reply bumps it. */
let attachEpoch = null;
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: "glitch-plugin-reload" })));
ws.on("error", (err) => {
	console.error(`ws error: ${err?.message ?? err}`);
	process.exit(1);
});
ws.on("message", (data) => {
	let m;
	try {
		m = JSON.parse(String(data));
	} catch {
		return;
	}
	if (m?.type === "ready" && !sent) {
		sent = true;
		ws.send(JSON.stringify({ type: "plugins_reload" }));
		console.log("sent plugins_reload");
		return;
	}
	if (m?.type === "plugins" && sent) {
		const epoch = m.epoch ?? 0;
		// First payload = attach-time snapshot, taken BEFORE the reload ran. Skipping
		// it matters: reloading without an epoch bump means the browser still has the
		// old cached bundle URL, so a "done" print must come from the bumped epoch.
		if (attachEpoch === null) {
			attachEpoch = epoch;
			return;
		}
		if (epoch === attachEpoch) return;
		printResult(m.plugins ?? [], epoch);
	}
});
function printResult(list, epoch) {
	if (PLUGIN_ID) {
		const mine = list.find((p) => p.id === PLUGIN_ID);
		if (!mine) {
			console.log(`${PLUGIN_ID}: NOT LOADED (epoch ${epoch})`);
		} else {
			const err = mine?.error ? ` ERROR: ${mine.error}` : "";
			console.log(`${mine.id}: v${mine.version ?? "?"} active=${mine.active} preload=${mine.preload} epoch=${epoch}${err}`);
		}
		process.exit(mine && !mine.error ? 0 : 1);
	}
	console.log(`epoch ${epoch}: ${list.map((p) => p.id ?? "?").join(", ") || "(none)"}`);
	process.exit(0);
}
setTimeout(() => {
	console.error("timeout waiting for the server");
	process.exit(1);
}, 20000);
