// The sync engine. Plain Node, no Obsidian imports, so it can be tested on its own.
//
// The vaults sync directly with each other: each item (a settings file, a theme, a snippet, a
// plugin's settings or its files) is copied from the vault that changed it into the others'
// config folders. Every item is compared as a whole by content hash, and against the hash each
// vault had the last time it synced, so the engine can tell which vault changed it. When more than
// one vault changed it, that is a conflict for the user (or the policy) to settle.
//
// Deletions never propagate: a vault that never had an item receives it, and one that removed an
// item after syncing it is left without it.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Group = "core" | "appearance" | "plugin";
/** Which copy wins when more than one vault changed an item since the last sync. */
export type Policy = "ask" | "newest" | "this";

export interface Item {
	id: string;
	/** The setting that picks the item. Every theme shares one, as does every snippet. */
	key: string;
	label: string;
	/** Shown under the label: the file or folder the item covers. */
	detail: string;
	group: Group;
	/** Paths relative to the config folder; a folder means everything under it. */
	paths: string[];
	/** The community plugin the item belongs to. */
	plugin?: string;
	/** Whether the item is picked before the user has chosen. */
	defaultOn: boolean;
}

export interface Vault {
	/** The vault folder; also the key its sync history is kept under. */
	path: string;
	name: string;
	/** The vault's config folder. */
	root: string;
}

export interface Side {
	/** Content hash, or "" when the vault has none of the item's files. */
	hash: string;
	/** Newest modified time among the item's files. */
	mtime: number;
}

export interface Entry {
	item: Item;
	/** One per vault, in the same order as the vaults. */
	sides: Side[];
	/** The vault whose copy is copied to `targets`, or null when there is nothing to copy. */
	source: number | null;
	targets: number[];
	/** More than one vault changed the item. */
	conflict: boolean;
	/** One vault for each version that could win, when there is a conflict. */
	choices: number[];
	reason: string;
}

/** Vault-specific files that never sync: open tabs, sidebar layout, saved workspaces. */
const SKIP_ROOT = new Set(["workspace.json", "workspace-mobile.json", "workspaces.json", "core-plugins-migration.json"]);

const CORE_LABELS: Record<string, string> = {
	"app.json": "Editor, files & links",
	"appearance.json": "Appearance",
	"hotkeys.json": "Hotkeys",
	"core-plugins.json": "Enabled core plugins",
	"community-plugins.json": "Enabled community plugins",
	"types.json": "Property types",
	"graph.json": "Graph view",
	"daily-notes.json": "Daily notes",
	"templates.json": "Templates",
	"zk-prefixer.json": "Unique note creator",
	"page-preview.json": "Page preview",
	"backlink.json": "Backlinks",
	"canvas.json": "Canvas",
	"bookmarks.json": "Bookmarks",
	"command-palette.json": "Command palette",
	"note-composer.json": "Note composer",
	"switcher.json": "Quick switcher",
};

/** Plugin code; anything else in a plugin's folder (caches, logs) is the plugin's own business. */
const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];

export function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function list(dir: string): string[] {
	try {
		return readdirSync(dir).filter((n) => n !== ".DS_Store").sort();
	} catch {
		return [];
	}
}

function titleCase(file: string): string {
	return file.replace(/\.json$/, "").replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function pluginName(roots: string[], id: string): string {
	for (const root of roots) {
		try {
			const name = JSON.parse(readFileSync(join(root, "plugins", id, "manifest.json"), "utf8")).name;
			if (typeof name === "string" && name) return name;
		} catch {
			// no manifest on this side
		}
	}
	return id;
}

/** Every item found in any of the config folders. `self` is this plugin's id. */
export function discover(roots: string[], self: string): Item[] {
	const items: Item[] = [];

	const rootJson = new Set(roots.flatMap((r) => list(r).filter((n) => n.endsWith(".json") && !isDir(join(r, n)))));
	for (const file of [...rootJson].sort()) {
		if (SKIP_ROOT.has(file)) continue;
		items.push({
			id: `core:${file}`,
			key: `core:${file}`,
			label: CORE_LABELS[file] ?? titleCase(file),
			detail: file,
			group: "core",
			paths: [file],
			// The enabled list turns plugins on and off everywhere, so it is opt-in.
			defaultOn: file !== "community-plugins.json",
		});
	}

	// One item per theme and per snippet, so vaults with different ones end up with all of them.
	const themes = new Set(roots.flatMap((r) => list(join(r, "themes")).filter((n) => isDir(join(r, "themes", n)))));
	for (const name of [...themes].sort()) {
		items.push({ id: `theme:${name}`, key: "themes", label: `Theme: ${name}`, detail: `themes/${name}/`, group: "appearance", paths: [`themes/${name}`], defaultOn: false });
	}
	const snippets = new Set(roots.flatMap((r) => list(join(r, "snippets")).filter((n) => n.endsWith(".css"))));
	for (const name of [...snippets].sort()) {
		items.push({ id: `snippet:${name}`, key: "snippets", label: `Snippet: ${name}`, detail: `snippets/${name}`, group: "appearance", paths: [`snippets/${name}`], defaultOn: false });
	}

	const ids = new Set(roots.flatMap((r) => list(join(r, "plugins")).filter((n) => isDir(join(r, "plugins", n)))));
	for (const id of [...ids].sort()) {
		if (id === self) continue;
		const name = pluginName(roots, id);
		items.push(
			{ id: `plugin:${id}`, key: `plugin:${id}`, label: name, detail: `plugins/${id}/data.json`, group: "plugin", paths: [`plugins/${id}/data.json`], plugin: id, defaultOn: false },
			{ id: `plugin-files:${id}`, key: `plugin-files:${id}`, label: name, detail: `plugins/${id}/`, group: "plugin", paths: PLUGIN_FILES.map((f) => `plugins/${id}/${f}`), plugin: id, defaultOn: false },
		);
	}
	return items;
}

function walk(root: string, rel: string, out: string[]): void {
	let st;
	try {
		st = statSync(join(root, rel));
	} catch {
		return;
	}
	if (st.isDirectory()) for (const name of list(join(root, rel))) walk(root, `${rel}/${name}`, out);
	else if (st.isFile()) out.push(rel);
}

/** The item's files that exist under `root`, as sorted relative paths. */
export function files(root: string, item: Item): string[] {
	const out: string[] = [];
	for (const path of item.paths) walk(root, path, out);
	return out.sort();
}

export function snapshot(root: string, item: Item): Side {
	const rels = files(root, item);
	if (!rels.length) return { hash: "", mtime: 0 };
	const hash = createHash("sha1");
	let mtime = 0;
	for (const rel of rels) {
		const abs = join(root, rel);
		hash.update(rel).update("\0").update(readFileSync(abs)).update("\0");
		mtime = Math.max(mtime, statSync(abs).mtimeMs);
	}
	return { hash: hash.digest("hex"), mtime };
}

/** The vaults that should get `source`'s copy: every vault holding a different one, and every vault
 * that never had the item. A vault that removed the item after syncing it is left alone. */
export function targetsFor(sides: Side[], last: (string | undefined)[], source: number): number[] {
	const hash = sides[source].hash;
	return sides.map((_, i) => i).filter((i) => sides[i].hash !== hash && (sides[i].hash || last[i] === undefined));
}

const names = (vaults: Vault[], idx: number[]) => idx.map((i) => vaults[i].name).join(", ");

/** Decide one item. `last[i]` is the hash vault i had when it last synced the item. Vault 0 is this one. */
export function decide(vaults: Vault[], sides: Side[], last: (string | undefined)[], policy: Policy): Omit<Entry, "item" | "sides"> {
	const nothing = (reason: string) => ({ source: null, targets: [], conflict: false, choices: [], reason });
	const present = sides.map((_, i) => i).filter((i) => sides[i].hash);
	if (!present.length) return nothing("Not in any vault");

	// The vaults whose copy changed since they last synced. If none did, but the copies differ anyway,
	// any of them could be the right one.
	const changed = present.filter((i) => sides[i].hash !== last[i]);
	const pool = changed.length ? changed : present;
	const choices = pool.filter((i, n) => pool.findIndex((j) => sides[j].hash === sides[i].hash) === n);

	if (choices.length > 1) {
		const reason = `Different in ${names(vaults, choices)}`;
		let source: number | null = null;
		if (policy === "newest") source = choices.reduce((a, b) => (sides[b].mtime > sides[a].mtime ? b : a));
		else if (policy === "this" && choices.includes(0)) source = 0;
		return { source, targets: source === null ? [] : targetsFor(sides, last, source), conflict: true, choices, reason };
	}

	const source = choices[0];
	const targets = targetsFor(sides, last, source);
	if (!targets.length) {
		const removed = sides.map((_, i) => i).filter((i) => !sides[i].hash);
		return nothing(removed.length ? `In sync; removed in ${names(vaults, removed)}` : "In sync");
	}
	const missing = targets.every((t) => !sides[t].hash);
	const reason = missing ? `Missing in ${names(vaults, targets)}` : `Changed in ${vaults[source].name}`;
	return { source, targets, conflict: false, choices: [], reason };
}

/** `last[vault path][item id]` is the hash that vault had after it last synced the item. */
export function plan(vaults: Vault[], items: Item[], last: Record<string, Record<string, string>>, policy: Policy): Entry[] {
	return items.map((item) => {
		const sides = vaults.map((v) => snapshot(v.root, item));
		const prev = vaults.map((v) => last[v.path]?.[item.id]);
		return { item, sides, ...decide(vaults, sides, prev, policy) };
	});
}

/** The vaults Obsidian has opened on this computer, from its own list. */
export function knownVaults(): string[] {
	const home = homedir();
	const dirs =
		process.platform === "darwin"
			? [join(home, "Library", "Application Support", "obsidian")]
			: process.platform === "win32"
				? [join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "obsidian")]
				: [join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "obsidian"), join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian")];
	for (const dir of dirs) {
		try {
			const vaults = JSON.parse(readFileSync(join(dir, "obsidian.json"), "utf8")).vaults ?? {};
			return Object.values(vaults as Record<string, { path?: string }>)
				.map((v) => v.path)
				.filter((p): p is string => typeof p === "string" && isDir(p))
				.sort();
		} catch {
			// not this platform's location, or Obsidian has no list yet
		}
	}
	return [];
}

/** Make `to` hold exactly `from`'s copy of the item. Does nothing when `from` has none of it. */
export function copyItem(from: string, to: string, item: Item): void {
	const src = files(from, item);
	if (!src.length) return;
	const keep = new Set(src);
	for (const rel of files(to, item)) if (!keep.has(rel)) rmSync(join(to, rel));
	for (const rel of src) {
		const dest = join(to, rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(join(from, rel), dest);
	}
}

/** Copy the item's current files under `root` into `dir`, keeping their relative paths. */
export function backup(root: string, item: Item, dir: string): void {
	for (const rel of files(root, item)) {
		const dest = join(dir, rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(join(root, rel), dest);
	}
}

/** Delete all but the newest `keep` backup folders. Folder names sort by time. */
export function pruneBackups(dir: string, keep: number): void {
	const all = list(dir).filter((n) => isDir(join(dir, n)));
	for (const name of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, name), { recursive: true, force: true });
}
