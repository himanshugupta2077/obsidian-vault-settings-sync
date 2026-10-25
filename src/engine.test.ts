import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { backup, copyItem, discover, expandHome, type Entry, type Item, plan, type Policy, pruneBackups, targetsFor, type Vault } from "./engine.ts";

function vault(name: string): Vault {
	const path = join(mkdtempSync(join(tmpdir(), "vss-")), name);
	mkdirSync(join(path, ".obsidian"), { recursive: true });
	return { path, name, root: join(path, ".obsidian") };
}

function put(v: Vault, rel: string, text: string): void {
	mkdirSync(dirname(join(v.root, rel)), { recursive: true });
	writeFileSync(join(v.root, rel), text);
}

function read(v: Vault, rel: string): string {
	return readFileSync(join(v.root, rel), "utf8");
}

type Last = Record<string, Record<string, string>>;

/** A tiny stand-in for the plugin: plan, then copy what the plan says. `pick` settles conflicts. */
function sync(vaults: Vault[], last: Last, opts: { policy?: Policy; pick?: Record<string, number> } = {}): Entry[] {
	const entries = plan(vaults, discover(vaults.map((v) => v.root), "self"), last, opts.policy ?? "ask");
	for (const e of entries) {
		let { source, targets } = e;
		if (opts.pick?.[e.item.id] !== undefined) {
			source = opts.pick[e.item.id];
			targets = targetsFor(e.sides, vaults.map((v) => last[v.path]?.[e.item.id]), source);
		}
		const remember = (i: number, hash: string) => ((last[vaults[i].path] ??= {})[e.item.id] = hash);
		if (source === null) {
			if (!e.conflict) e.sides.forEach((s, i) => s.hash && remember(i, s.hash));
			continue;
		}
		for (const t of targets) {
			copyItem(vaults[source].root, vaults[t].root, e.item);
			remember(t, e.sides[source].hash);
		}
		remember(source, e.sides[source].hash);
	}
	return entries;
}

const find = (entries: Entry[], id: string) => entries.find((e) => e.item.id === id)!;
const copies = (entries: Entry[]) => entries.filter((e) => e.targets.length).map((e) => e.item.id);

describe("discover", () => {
	it("lists every vault's settings files, themes, snippets and plugins", () => {
		const a = vault("a");
		const b = vault("b");
		put(a, "app.json", "{}");
		put(a, "workspace.json", "{}");
		put(a, "themes/Minimal/theme.css", "");
		put(b, "snippets/wide.css", "");
		put(b, "daily-notes.json", "{}");
		put(a, "community-plugins.json", "[]");
		put(a, "plugins/dataview/manifest.json", JSON.stringify({ name: "Dataview" }));
		put(b, "plugins/calendar/data.json", "{}");
		put(a, "plugins/self/data.json", "{}");

		const items = discover([a.root, b.root], "self");
		assert.deepEqual(items.map((i) => i.id), [
			"core:app.json",
			"core:daily-notes.json",
			"theme:Minimal",
			"snippet:wide.css",
			"plugin:calendar",
			"plugin-files:calendar",
			"plugin:dataview",
			"plugin-files:dataview",
		]);
		const byId = (id: string) => items.find((i) => i.id === id) as Item;
		assert.equal(byId("core:app.json").label, "Editor, files & links");
		assert.equal(byId("plugin:dataview").label, "Dataview");
		assert.equal(byId("theme:Minimal").key, "themes");
	});

	it("marks appearance settings, themes, snippets and Style Settings as appearance, off by default", () => {
		const a = vault("a");
		put(a, "app.json", "{}");
		put(a, "appearance.json", "{}");
		put(a, "themes/Minimal/theme.css", "");
		put(a, "snippets/wide.css", "");
		put(a, "plugins/obsidian-style-settings/data.json", "{}");
		put(a, "plugins/dataview/data.json", "{}");
		const items = discover([a.root], "self");
		const look = items.filter((i) => i.appearance).map((i) => i.id);
		assert.deepEqual(look, ["core:appearance.json", "theme:Minimal", "snippet:wide.css", "plugin:obsidian-style-settings"]);
		assert.ok(items.filter((i) => i.appearance).every((i) => !i.defaultOn));
		assert.equal(items.find((i) => i.id === "core:appearance.json")?.group, "appearance");
		assert.ok(!items.find((i) => i.id === "plugin-files:obsidian-style-settings")?.appearance);
	});

	it("picks only Obsidian's own settings by default", () => {
		const a = vault("a");
		put(a, "app.json", "{}");
		put(a, "hotkeys.json", "{}");
		put(a, "community-plugins.json", "[]");
		put(a, "themes/Minimal/theme.css", "");
		put(a, "snippets/wide.css", "");
		put(a, "plugins/dataview/data.json", "{}");
		const on = discover([a.root], "self").filter((i) => i.defaultOn).map((i) => i.id);
		assert.deepEqual(on, ["core:app.json", "core:hotkeys.json"]);
	});
});

describe("sync between vaults", () => {
	it("copies a change from whichever vault made it to all the others", () => {
		const [personal, work, writing] = [vault("personal"), vault("work"), vault("writing")];
		const vaults = [personal, work, writing];
		const last: Last = {};
		put(personal, "hotkeys.json", "1");

		// The others never had it, so they just get it.
		const first = sync(vaults, last);
		assert.equal(find(first, "core:hotkeys.json").reason, "Missing in work, writing");
		assert.equal(read(writing, "hotkeys.json"), "1");

		// A change in work (not this vault) reaches personal and writing.
		put(work, "hotkeys.json", "2");
		const second = sync(vaults, last);
		assert.equal(find(second, "core:hotkeys.json").reason, "Changed in work");
		assert.deepEqual(find(second, "core:hotkeys.json").targets, [0, 2]);
		assert.equal(read(personal, "hotkeys.json"), "2");
		assert.equal(read(writing, "hotkeys.json"), "2");

		assert.deepEqual(copies(sync(vaults, last)), []);
	});

	it("asks when vaults differ the first time they meet, then keeps the copy picked", () => {
		const [a, b] = [vault("a"), vault("b")];
		const last: Last = {};
		put(a, "app.json", "from a");
		put(b, "app.json", "from b");

		const entries = sync([a, b], last);
		const app = find(entries, "core:app.json");
		assert.equal(app.conflict, true);
		assert.equal(app.source, null);
		assert.equal(app.reason, "Different in a, b");
		assert.equal(read(b, "app.json"), "from b");

		sync([a, b], last, { pick: { "core:app.json": 1 } });
		assert.equal(read(a, "app.json"), "from b");
		assert.deepEqual(copies(sync([a, b], last)), []);
	});

	it("flags a conflict when two vaults changed the same thing", () => {
		const [a, b, c] = [vault("a"), vault("b"), vault("c")];
		const last: Last = {};
		put(a, "app.json", "0");
		sync([a, b, c], last);
		put(a, "app.json", "a");
		put(c, "app.json", "c");
		const e = find(sync([a, b, c], last), "core:app.json");
		assert.equal(e.conflict, true);
		assert.deepEqual(e.choices, [0, 2]);
		assert.equal(read(b, "app.json"), "0");
	});

	it("settles conflicts by policy", () => {
		const [a, b] = [vault("a"), vault("b")];
		put(a, "app.json", "old");
		put(b, "app.json", "new");
		utimesSync(join(a.root, "app.json"), 1000, 1000);
		const newest = plan([a, b], discover([a.root, b.root], "self"), {}, "newest")[0];
		assert.deepEqual([newest.source, newest.targets], [1, [0]]);
		const mine = plan([a, b], discover([a.root, b.root], "self"), {}, "this")[0];
		assert.deepEqual([mine.source, mine.targets], [0, [1]]);
	});

	it("gives every vault every theme instead of replacing one set with another", () => {
		const [a, b] = [vault("a"), vault("b")];
		put(a, "themes/Minimal/theme.css", "m");
		put(b, "themes/Things/theme.css", "t");
		sync([a, b], {});
		assert.deepEqual(readdirSync(join(a.root, "themes")).sort(), ["Minimal", "Things"]);
		assert.deepEqual(readdirSync(join(b.root, "themes")).sort(), ["Minimal", "Things"]);
	});

	it("leaves a removed snippet removed, without deleting it anywhere else", () => {
		const [a, b] = [vault("a"), vault("b")];
		const last: Last = {};
		put(a, "snippets/old.css", "p{}");
		sync([a, b], last);
		rmSync(join(b.root, "snippets/old.css"));
		const e = find(sync([a, b], last), "snippet:old.css");
		assert.deepEqual(e.targets, []);
		assert.equal(e.reason, "In sync; removed in b");
		assert.equal(existsSync(join(b.root, "snippets/old.css")), false);
		assert.equal(read(a, "snippets/old.css"), "p{}");

		// A later change in a still doesn't bring it back to b.
		put(a, "snippets/old.css", "p{color:red}");
		assert.deepEqual(find(sync([a, b], last), "snippet:old.css").targets, []);
	});

	it("copies only a plugin's code as plugin files, not its caches", () => {
		const [a, b] = [vault("a"), vault("b")];
		put(a, "plugins/calendar/manifest.json", "{}");
		put(a, "plugins/calendar/main.js", "code");
		put(a, "plugins/calendar/cache.json", "x");
		put(b, "plugins/calendar/manifest.json", "{}");
		// b has its own, different copy, so the first sync asks; keep a's.
		const entries = sync([a, b], {}, { pick: { "plugin-files:calendar": 0 } });
		assert.equal(find(entries, "plugin-files:calendar").conflict, true);
		assert.equal(read(b, "plugins/calendar/main.js"), "code");
		assert.equal(existsSync(join(b.root, "plugins/calendar/cache.json")), false);
	});

	it("never installs a plugin or its settings in a vault that doesn't have it", () => {
		const [a, b] = [vault("a"), vault("b")];
		put(a, "plugins/calendar/manifest.json", "{}");
		put(a, "plugins/calendar/main.js", "code");
		put(a, "plugins/calendar/data.json", "{}");
		const entries = sync([a, b], {});
		assert.deepEqual(find(entries, "plugin-files:calendar").targets, []);
		assert.deepEqual(find(entries, "plugin:calendar").targets, []);
		assert.equal(find(entries, "plugin:calendar").reason, "In sync");
		assert.equal(existsSync(join(b.root, "plugins/calendar")), false);

		// Once it's installed there, its settings follow.
		put(b, "plugins/calendar/manifest.json", "{}");
		assert.deepEqual(find(sync([a, b], {}), "plugin:calendar").targets, [1]);
		assert.equal(read(b, "plugins/calendar/data.json"), "{}");
	});
});

describe("backups", () => {
	it("copies an item's files and keeps only the newest folders", () => {
		const a = vault("a");
		const dir = mkdtempSync(join(tmpdir(), "vss-"));
		put(a, "snippets/a.css", "a");
		const item = discover([a.root], "self").find((i) => i.id === "snippet:a.css") as Item;
		backup(a.root, item, join(dir, "2026-01-03"));
		assert.equal(readFileSync(join(dir, "2026-01-03", "snippets/a.css"), "utf8"), "a");
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
