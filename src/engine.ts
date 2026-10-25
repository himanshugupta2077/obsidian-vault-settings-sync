// The sync engine. Plain Node, no Obsidian imports, so it can be tested on its own.
//
// The hub is a folder laid out exactly like a vault's config folder (.obsidian): app.json at the
// top, plugins/<id>/data.json, themes/, snippets/. Each vault copies the items it has picked to
// and from the hub. Every item is compared as a whole by content hash, against the hash both
// sides had the last time this vault synced it (a three-way compare), so the engine knows which
// side changed. Deletions never propagate: a side that lacks an item just receives it.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Group = "core" | "appearance" | "plugin";
/** What to do when an item changed in this vault and in the hub since the last sync. */
export type Policy = "ask" | "newest" | "local" | "hub";
export type Action = "none" | "push" | "pull" | "skip";

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

export interface Side {
	/** Content hash, or "" when the side has none of the item's files. */
	hash: string;
	/** Newest modified time among the item's files. */
	mtime: number;
}

export interface Entry {
	item: Item;
	local: Side;
	hub: Side;
	action: Action;
	/** Both sides changed since the last sync. */
	conflict: boolean;
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

/** Every item found in this vault's config folder or in the hub. `self` is this plugin's id. */
export function discover(local: string, hub: string, self: string): Item[] {
	const roots = [local, hub];
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
		items.push({ id: `theme:${name}`, key: "themes", label: `Theme: ${name}`, detail: `themes/${name}/`, group: "appearance", paths: [`themes/${name}`], defaultOn: true });
	}
	const snippets = new Set(roots.flatMap((r) => list(join(r, "snippets")).filter((n) => n.endsWith(".css"))));
	for (const name of [...snippets].sort()) {
		items.push({ id: `snippet:${name}`, key: "snippets", label: `Snippet: ${name}`, detail: `snippets/${name}`, group: "appearance", paths: [`snippets/${name}`], defaultOn: true });
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

/** Decide one item. `last` is the hash both sides had when this vault last synced it. */
export function decide(local: Side, hub: Side, last: string | undefined, policy: Policy): Omit<Entry, "item" | "local" | "hub"> {
	if (local.hash === hub.hash) return { action: "none", conflict: false, reason: local.hash ? "In sync" : "Not in this vault or the hub" };
	if (!hub.hash) return { action: "push", conflict: false, reason: "Not in the hub yet" };
	if (!local.hash) {
		// Removed from this vault after it last synced: leave it gone here, and in the hub.
		if (last === hub.hash) return { action: "none", conflict: false, reason: "Removed in this vault" };
		return { action: "pull", conflict: false, reason: "Only in the hub" };
	}
	if (last === local.hash) return { action: "pull", conflict: false, reason: "Changed in the hub" };
	if (last === hub.hash) return { action: "push", conflict: false, reason: "Changed in this vault" };
	const reason = last === undefined ? "Different here and in the hub" : "Changed here and in the hub";
	if (policy === "local") return { action: "push", conflict: true, reason };
	if (policy === "hub") return { action: "pull", conflict: true, reason };
	if (policy === "newest") return { action: local.mtime >= hub.mtime ? "push" : "pull", conflict: true, reason };
	return { action: "skip", conflict: true, reason };
}

export function plan(local: string, hub: string, items: Item[], last: Record<string, string>, policy: Policy): Entry[] {
	return items.map((item) => {
		const l = snapshot(local, item);
		const h = snapshot(hub, item);
		return { item, local: l, hub: h, ...decide(l, h, last[item.id], policy) };
	});
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
