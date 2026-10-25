import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { backup, copyItem, decide, discover, expandHome, type Entry, type Item, plan, pruneBackups, snapshot } from "./engine.ts";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "vss-"));
}

function put(root: string, rel: string, text: string): void {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), text);
}

function read(root: string, rel: string): string {
	return readFileSync(join(root, rel), "utf8");
}

/** A tiny stand-in for the plugin: plan, then do what the plan says. */
function sync(local: string, hub: string, items: Item[], last: Record<string, string>, override: Partial<Record<string, "push" | "pull">> = {}): Entry[] {
	const entries = plan(local, hub, items, last, "ask");
	for (const e of entries) {
		const action = override[e.item.id] ?? e.action;
		if (action === "push") {
			copyItem(local, hub, e.item);
			last[e.item.id] = e.local.hash;
		} else if (action === "pull") {
			copyItem(hub, local, e.item);
			last[e.item.id] = e.hub.hash;
		} else if (action === "none" && e.local.hash) last[e.item.id] = e.local.hash;
	}
	return entries;
}

const byId = (items: Item[], id: string) => items.find((i) => i.id === id)!;

describe("discover", () => {
	it("lists config files, themes, snippets and plugins from both sides", () => {
		const local = tmp();
		const hub = tmp();
		put(local, "app.json", "{}");
		put(local, "workspace.json", "{}");
		put(local, "themes/Minimal/theme.css", "");
		put(hub, "snippets/wide.css", "");
		put(hub, "daily-notes.json", "{}");
		put(local, "community-plugins.json", "[]");
		put(local, "plugins/dataview/manifest.json", JSON.stringify({ name: "Dataview" }));
		put(hub, "plugins/calendar/data.json", "{}");
		put(local, "plugins/vault-settings-sync/data.json", "{}");

		const items = discover(local, hub, "vault-settings-sync");
		const ids = items.map((i) => i.id);
		assert.deepEqual(ids, [
			"core:app.json",
			"core:community-plugins.json",
			"core:daily-notes.json",
			"theme:Minimal",
			"snippet:wide.css",
			"plugin:calendar",
			"plugin-files:calendar",
			"plugin:dataview",
			"plugin-files:dataview",
		]);
		assert.equal(byId(items, "core:app.json").label, "Editor, files & links");
		assert.equal(byId(items, "core:community-plugins.json").defaultOn, false);
		assert.equal(byId(items, "plugin:dataview").label, "Dataview");
		assert.equal(byId(items, "plugin:calendar").label, "calendar");
		assert.equal(byId(items, "theme:Minimal").key, "themes");
	});
});

describe("decide", () => {
	const side = (hash: string, mtime = 0) => ({ hash, mtime });

	it("knows which side changed from the last synced hash", () => {
		assert.equal(decide(side("a"), side("a"), undefined, "ask").action, "none");
		assert.equal(decide(side("a"), side(""), undefined, "ask").action, "push");
		assert.equal(decide(side(""), side("a"), undefined, "ask").action, "pull");
		assert.equal(decide(side("a"), side("b"), "a", "ask").action, "pull");
		assert.equal(decide(side("b"), side("a"), "a", "ask").action, "push");
		assert.deepEqual(decide(side(""), side("a"), "a", "ask"), { action: "none", conflict: false, reason: "Removed in this vault" });
	});

	it("follows the policy when both changed", () => {
		const l = side("l", 200);
		const h = side("h", 100);
		assert.deepEqual(decide(l, h, "x", "ask"), { action: "skip", conflict: true, reason: "Changed here and in the hub" });
		assert.equal(decide(l, h, "x", "newest").action, "push");
		assert.equal(decide(side("l", 1), h, "x", "newest").action, "pull");
		assert.equal(decide(l, h, "x", "local").action, "push");
		assert.equal(decide(l, h, undefined, "hub").action, "pull");
	});
});

describe("sync between two vaults", () => {
	it("carries a change from one vault to the other through the hub", () => {
		const personal = tmp();
		const work = tmp();
		const hub = tmp();
		const lastP: Record<string, string> = {};
		const lastW: Record<string, string> = {};
		put(personal, "hotkeys.json", '{"a":1}');
		put(personal, "snippets/wide.css", "body{}");
		put(personal, "snippets/old.css", "p{}");
		const items = () => discover(personal, hub, "self");

		sync(personal, hub, items(), lastP);
		assert.equal(read(hub, "hotkeys.json"), '{"a":1}');

		// The work vault has never synced and has nothing yet: it just receives everything.
		const pulled = sync(work, hub, discover(work, hub, "self"), lastW);
		assert.deepEqual(pulled.filter((e) => e.action === "pull").map((e) => e.item.id), ["core:hotkeys.json", "snippet:old.css", "snippet:wide.css"]);
		assert.equal(read(work, "snippets/wide.css"), "body{}");

		// Change a setting and edit a snippet in work; personal gets both on its next sync.
		put(work, "hotkeys.json", '{"a":2}');
		put(work, "snippets/wide.css", "body{color:red}");
		sync(work, hub, discover(work, hub, "self"), lastW);
		const again = sync(personal, hub, items(), lastP);
		assert.deepEqual(again.filter((e) => e.action === "pull").map((e) => e.item.id), ["core:hotkeys.json", "snippet:wide.css"]);
		assert.equal(read(personal, "hotkeys.json"), '{"a":2}');
		assert.equal(read(personal, "snippets/wide.css"), "body{color:red}");

		// A snippet removed in work stays removed there, and personal keeps its copy.
		rmSync(join(work, "snippets/old.css"));
		sync(work, hub, discover(work, hub, "self"), lastW);
		assert.equal(existsSync(join(work, "snippets/old.css")), false);
		assert.equal(read(personal, "snippets/old.css"), "p{}");

		// Now everything settles.
		assert.ok(sync(personal, hub, items(), lastP).every((e) => e.action === "none"));
		assert.ok(sync(work, hub, discover(work, hub, "self"), lastW).every((e) => e.action === "none"));
	});

	it("flags a conflict when both changed, and keeps the side the user picks", () => {
		const a = tmp();
		const b = tmp();
		const hub = tmp();
		const lastA: Record<string, string> = {};
		const lastB: Record<string, string> = {};
		put(a, "app.json", "1");
		sync(a, hub, discover(a, hub, "self"), lastA);
		sync(b, hub, discover(b, hub, "self"), lastB);
		put(a, "app.json", "from a");
		put(b, "app.json", "from b");
		sync(a, hub, discover(a, hub, "self"), lastA);

		const entries = sync(b, hub, discover(b, hub, "self"), lastB);
		const app = entries.find((e) => e.item.id === "core:app.json")!;
		assert.equal(app.action, "skip");
		assert.equal(app.conflict, true);
		assert.equal(read(b, "app.json"), "from b");

		sync(b, hub, discover(b, hub, "self"), lastB, { "core:app.json": "push" });
		assert.equal(read(hub, "app.json"), "from b");
		sync(a, hub, discover(a, hub, "self"), lastA);
		assert.equal(read(a, "app.json"), "from b");
	});

	it("adds themes from both vaults instead of replacing one set with the other", () => {
		const a = tmp();
		const b = tmp();
		const hub = tmp();
		put(a, "themes/Minimal/theme.css", "m");
		put(b, "themes/Things/theme.css", "t");
		sync(a, hub, discover(a, hub, "self"), {});
		sync(b, hub, discover(b, hub, "self"), {});
		sync(a, hub, discover(a, hub, "self"), {});
		assert.deepEqual(readdirSync(join(a, "themes")).sort(), ["Minimal", "Things"]);
		assert.deepEqual(readdirSync(join(b, "themes")).sort(), ["Minimal", "Things"]);
	});

	it("never deletes a plugin from the other side", () => {
		const local = tmp();
		const hub = tmp();
		put(hub, "plugins/calendar/main.js", "code");
		put(hub, "plugins/calendar/data.json", "{}");
		const last: Record<string, string> = {};
		const entries = sync(local, hub, discover(local, hub, "self"), last);
		assert.equal(entries.find((e) => e.item.id === "plugin-files:calendar")!.action, "pull");
		assert.equal(read(local, "plugins/calendar/main.js"), "code");
		// Plugin files are only main.js, manifest.json and styles.css.
		put(local, "plugins/calendar/cache.json", "x");
		assert.equal(snapshot(local, byId(discover(local, hub, "self"), "plugin-files:calendar")).hash, last["plugin-files:calendar"]);
	});

	it("uses the newest side under the newest policy", () => {
		const local = tmp();
		const hub = tmp();
		put(local, "app.json", "old");
		put(hub, "app.json", "new");
		utimesSync(join(local, "app.json"), 1000, 1000);
		const [entry] = plan(local, hub, discover(local, hub, "self").filter((i) => i.id === "core:app.json"), {}, "newest");
		assert.equal(entry.action, "pull");
	});
});

describe("backups", () => {
	it("copies an item's files and keeps only the newest folders", () => {
		const root = tmp();
		const dir = tmp();
		put(root, "snippets/a.css", "a");
		backup(root, byId(discover(root, tmp(), "self"), "snippet:a.css"), join(dir, "2026-01-03"));
		assert.equal(read(join(dir, "2026-01-03"), "snippets/a.css"), "a");
		mkdirSync(join(dir, "2026-01-01"));
		mkdirSync(join(dir, "2026-01-02"));
		pruneBackups(dir, 2);
		assert.deepEqual(readdirSync(dir).sort(), ["2026-01-02", "2026-01-03"]);
	});
});

it("expands ~ to the home folder", () => {
	assert.ok(!expandHome("~/x").startsWith("~"));
	assert.equal(expandHome("/a/~b"), "/a/~b");
});
