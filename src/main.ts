import { FileSystemAdapter, Modal, Notice, Plugin, ViewState, WorkspaceLeaf } from "obsidian";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { backup, copyItem, discover, Entry, expandHome, installed, Item, plan, Policy, pruneBackups, targetsFor, Vault } from "./engine";
import { SyncSettingTab } from "./settings";

export interface Settings {
	/** The other vaults' folders. `~` is allowed. */
	vaults: string[];
	syncOnStartup: boolean;
	/** Minutes between automatic syncs; 0 turns them off. */
	intervalMinutes: number;
	policy: Policy;
	/** Reload Obsidian by itself when new settings need it. */
	autoReload: boolean;
	/** Sync appearance settings, themes, snippets and Style Settings. Off keeps each vault's look its own. */
	syncAppearance: boolean;
	/** Item key → picked. Missing keys use the item's default. */
	selected: Record<string, boolean>;
	/** Vault folder → item id → the hash that vault had after it last synced the item. */
	last: Record<string, Record<string, string>>;
}

const DEFAULTS: Settings = {
	vaults: [],
	syncOnStartup: true,
	intervalMinutes: 0,
	policy: "ask",
	autoReload: false,
	syncAppearance: false,
	selected: {},
	last: {},
};

const KEEP_BACKUPS = 10;

/** Obsidian internals the plugin uses to restart a plugin after pulling its settings. */
interface InternalApp {
	plugins: {
		enabledPlugins: Set<string>;
		disablePlugin(id: string): Promise<void>;
		enablePlugin(id: string): Promise<void>;
		enablePluginAndSave(id: string): Promise<void>;
		loadManifests(): Promise<void>;
	};
	commands: { executeCommandById(id: string): boolean };
	viewRegistry: { getViewCreatorByType(type: string): unknown };
}

export default class SettingsSyncPlugin extends Plugin {
	settings!: Settings;
	private busy = false;
	private timer: number | null = null;

	async onload(): Promise<void> {
		const data = (await this.loadData()) ?? {};
		// 1.0.0 synced through a hub folder; its history doesn't apply to vault-to-vault sync.
		if ("hubPath" in data) {
			delete data.hubPath;
			delete data.lastHub;
			data.last = {};
		}
		this.settings = { ...DEFAULTS, ...data };
		this.addSettingTab(new SyncSettingTab(this.app, this));
		this.addRibbonIcon("refresh-cw", "Sync settings with your other vaults", () => this.sync(true));
		this.addCommand({ id: "sync", name: "Sync now", callback: () => this.sync(true) });
		this.addCommand({ id: "preview", name: "Preview sync", callback: () => this.preview() });
		this.addCommand({ id: "copy-this", name: "Make every vault match this one (for everything picked)", callback: () => this.copyThis() });
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.syncOnStartup) void this.sync(false);
		});
		this.schedule();
	}

	async save(): Promise<void> {
		await this.saveData(this.settings);
	}

	schedule(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		if (this.settings.intervalMinutes > 0) {
			this.timer = window.setInterval(() => void this.sync(false), this.settings.intervalMinutes * 60_000);
			this.registerInterval(this.timer);
		}
	}

	get vaultPath(): string {
		return (this.app.vault.adapter as FileSystemAdapter).getBasePath();
	}

	private get internal(): InternalApp {
		return this.app as unknown as InternalApp;
	}

	/** The config folder of the vault at `path`, which uses the same name as this vault's. */
	configRoot(path: string): string {
		return join(path, this.app.vault.configDir);
	}

	/** This vault first, then each linked vault whose config folder can be read right now. */
	vaults(): { vaults: Vault[]; missing: string[] } {
		const here = this.vaultPath;
		const vaults: Vault[] = [{ path: here, name: `${this.app.vault.getName()} (this vault)`, root: this.configRoot(here) }];
		const missing: string[] = [];
		for (const raw of this.settings.vaults) {
			const path = resolve(expandHome(raw));
			if (path === here || vaults.some((v) => v.path === path)) continue;
			if (existsSync(this.configRoot(path))) vaults.push({ path, name: basename(path), root: this.configRoot(path) });
			else missing.push(path);
		}
		// Two vaults with the same folder name: tell them apart by their parent folder.
		for (const v of vaults.slice(1)) {
			if (vaults.filter((w) => w.name === v.name).length > 1) v.name = `${basename(join(v.path, ".."))}/${v.name}`;
		}
		return { vaults, missing };
	}

	items(vaults = this.vaults().vaults): Item[] {
		return discover(vaults.map((v) => v.root), this.manifest.id);
	}

	isSelected(item: Item): boolean {
		if (item.appearance && !this.settings.syncAppearance) return false;
		return this.settings.selected[item.key] ?? item.defaultOn;
	}

	/** The plan for every item, picked or not. */
	planAll(vaults = this.vaults().vaults): Entry[] {
		return plan(vaults, this.items(vaults), this.settings.last, this.settings.policy);
	}

	/** The vaults and the plan for the picked items, or null when there is nothing to sync with. */
	private ready(manual: boolean): { vaults: Vault[]; entries: Entry[] } | null {
		const { vaults, missing } = this.vaults();
		// A vault on a drive that isn't mounted is just left out of this sync.
		if (manual && missing.length) new Notice(`Settings sync: can't find ${missing.join(", ")}. Skipping it.`);
		if (vaults.length < 2) {
			if (manual) new Notice("Settings sync: add the vaults to sync with in the plugin settings first.");
			return null;
		}
		return { vaults, entries: this.planAll(vaults).filter((e) => this.isSelected(e.item)) };
	}

	async sync(manual: boolean): Promise<void> {
		const run = this.ready(manual);
		if (!run) return;
		await this.apply(run.vaults, run.entries, manual);
		const conflicts = run.entries.filter((e) => e.conflict && e.source === null).length;
		if (conflicts) {
			const frag = createFragment((f) => {
				f.appendText(`Settings sync: ${conflicts} item${conflicts > 1 ? "s" : ""} changed in more than one vault. `);
				f.createEl("a", { text: "Choose which to keep", href: "#" }).onclick = () => this.preview();
			});
			new Notice(frag, 0);
		}
	}

	preview(): void {
		const run = this.ready(true);
		if (run) new PreviewModal(this, run.vaults, run.entries).open();
	}

	private async copyThis(): Promise<void> {
		const run = this.ready(true);
		if (!run) return;
		const last = run.vaults.map(() => undefined);
		await this.apply(
			run.vaults,
			run.entries.map((e) => (e.sides[0].hash ? { ...e, source: 0, targets: targetsFor(e.sides, last, 0) } : { ...e, source: null, targets: [] })),
			true,
		);
	}

	/** Copy each entry's source copy into its target vaults. */
	async apply(vaults: Vault[], entries: Entry[], manual: boolean): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const failed: string[] = [];
		const updated = new Set<number>();
		let copied = 0;
		let needsReload = false;
		const remember = (v: Vault, item: Item, hash: string) => ((this.settings.last[v.path] ??= {})[item.id] = hash);
		try {
			for (const e of entries) {
				if (e.source !== null) continue;
				// Nothing to copy. Unless the vaults disagree, they all have the copy they should.
				if (!e.conflict) e.sides.forEach((s, i) => s.hash && remember(vaults[i], e.item, s.hash));
			}
			const work = entries.filter((e) => e.source !== null && e.targets.length);
			if (!work.length) return;

			// Stop a running plugin before replacing its settings, so it can't save its old ones over
			// them on the way out, and start it again to load the new ones.
			const plugins = this.internal.plugins;
			const intoThis = work.filter((e) => e.targets.includes(0));
			const restart = [...new Set(intoThis.map((e) => e.item.plugin))].filter((id): id is string => !!id && plugins.enabledPlugins.has(id));
			// Disabling a plugin turns its open tabs into blank placeholders; note what they showed.
			const tabs = new Map<WorkspaceLeaf, ViewState>();
			if (restart.length) this.app.workspace.iterateAllLeaves((leaf) => {
				tabs.set(leaf, leaf.getViewState());
			});
			for (const id of restart) await plugins.disablePlugin(id);
			const gone = new Set([...tabs.values()].map((v) => v.type).filter((t) => !this.internal.viewRegistry.getViewCreatorByType(t)));

			const backups = join(vaults[0].root, "plugins", this.manifest.id, "backups");
			const dir = join(backups, new Date().toISOString().replace(/[:.]/g, "-"));
			for (const e of work) {
				const from = vaults[e.source as number];
				const hash = e.sides[e.source as number].hash;
				try {
					for (const t of e.targets) {
						backup(vaults[t].root, e.item, join(dir, basename(vaults[t].path)));
						copyItem(from.root, vaults[t].root, e.item);
						remember(vaults[t], e.item, hash);
						updated.add(t);
						if (t === 0 && e.item.group !== "plugin") needsReload = true;
					}
					remember(from, e.item, hash);
					copied++;
				} catch (err) {
					failed.push(`${e.item.label}: ${(err as Error).message}`);
				}
			}
			pruneBackups(backups, KEEP_BACKUPS);

			if (intoThis.some((e) => e.item.id.startsWith("plugin-files:"))) await plugins.loadManifests();
			for (const id of restart) await plugins.enablePlugin(id);
			for (const [leaf, view] of tabs) if (gone.has(view.type)) await leaf.setViewState(view);
		} finally {
			this.busy = false;
			await this.save();
		}

		if (failed.length) new Notice(`Settings sync failed for:\n${failed.join("\n")}`, 0);
		if (copied) new Notice(`Settings sync: updated ${copied} item${copied === 1 ? "" : "s"} in ${[...updated].map((i) => vaults[i].name).join(", ")}.`);
		else if (manual && !failed.length) new Notice("Settings sync: everything is in sync.");
		if (needsReload) this.offerReload();
	}

	/** Install a community plugin into vault `target` by copying it from a vault that has it, and turn it on. */
	async install(vaults: Vault[], plugin: string, target: number): Promise<void> {
		// Prefer this vault's copy, the one known to work here.
		const from = vaults.find((v) => installed(v.root, plugin));
		const item = this.items(vaults).find((i) => i.id === `plugin-files:${plugin}`);
		if (!from || !item) return;
		const to = vaults[target];
		try {
			copyItem(from.root, to.root, item);
			if (target === 0) {
				await this.internal.plugins.loadManifests();
				await this.internal.plugins.enablePluginAndSave(plugin);
				new Notice(`Installed and turned on ${item.label}.`);
			} else {
				// Turn it on in that vault's list; Obsidian loads it the next time that vault opens.
				const list = join(to.root, "community-plugins.json");
				const on: string[] = existsSync(list) ? JSON.parse(readFileSync(list, "utf8")) : [];
				if (!on.includes(plugin)) writeFileSync(list, JSON.stringify([...on, plugin], null, 2));
				new Notice(`Installed ${item.label} in ${to.name}. It turns on the next time ${to.name} opens or reloads.`);
			}
		} catch (err) {
			new Notice(`Couldn't install ${item.label} in ${to.name}: ${(err as Error).message}`, 0);
		}
	}

	private offerReload(): void {
		const reload = () => this.internal.commands.executeCommandById("app:reload");
		if (this.settings.autoReload) {
			new Notice("Settings sync: reloading to apply the new settings…");
			window.setTimeout(reload, 1500);
			return;
		}
		const frag = createFragment((f) => {
			f.appendText("Settings sync: some new settings apply after a reload. ");
			f.createEl("a", { text: "Reload now", href: "#" }).onclick = reload;
		});
		new Notice(frag, 0);
	}
}

/** Lists what a sync would change, and lets the user pick whose copy wins for each item. */
class PreviewModal extends Modal {
	constructor(private plugin: SettingsSyncPlugin, private vaults: Vault[], private entries: Entry[]) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Settings sync");
		contentEl.createEl("p", { cls: "vss-muted", text: `Vaults: ${this.vaults.map((v) => v.name).join(", ")}` });
		const changes = this.entries.filter((e) => e.targets.length || e.conflict);
		const same = this.entries.length - changes.length;
		if (!changes.length) {
			contentEl.createEl("p", { text: `All ${same} picked items are in sync.` });
			return;
		}
		contentEl.createEl("p", { cls: "vss-muted", text: `${same} picked item${same === 1 ? " is" : "s are"} already in sync.` });
		const chosen = new Map<Entry, number | null>(changes.map((e) => [e, e.source]));
		const table = contentEl.createDiv({ cls: "vss-preview" });
		for (const e of changes) {
			const row = table.createDiv({ cls: "vss-row" + (e.conflict ? " vss-conflict" : "") });
			const text = row.createDiv({ cls: "vss-row-text" });
			text.createDiv({ text: e.item.group === "plugin" ? `${e.item.label} · ${e.item.id.startsWith("plugin:") ? "settings" : "plugin files"}` : e.item.label });
			text.createDiv({ cls: "vss-muted", text: `${e.reason} · ${e.item.detail}` });
			const to = text.createDiv({ cls: "vss-muted" });
			const last = this.vaults.map((v) => this.plugin.settings.last[v.path]?.[e.item.id]);
			const show = (source: number | null) =>
				to.setText(source === null ? "Left as it is" : `Copies ${this.vaults[source].name}'s to ${targetsFor(e.sides, last, source).map((t) => this.vaults[t].name).join(", ")}`);
			show(e.source);

			// Any vault holding a distinct copy can be the one to keep.
			const holders = e.sides.map((_, i) => i).filter((i, n, all) => e.sides[i].hash && all.findIndex((j) => e.sides[j].hash === e.sides[i].hash) === n);
			const select = row.createEl("select", { cls: "dropdown" });
			for (const i of holders) select.createEl("option", { value: String(i), text: `Keep ${this.vaults[i].name}'s` });
			select.createEl("option", { value: "skip", text: "Skip" });
			select.value = e.source === null ? "skip" : String(e.source);
			select.onchange = () => {
				const source = select.value === "skip" ? null : Number(select.value);
				chosen.set(e, source);
				show(source);
			};
		}
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		const go = buttons.createEl("button", { text: "Sync", cls: "mod-cta" });
		go.onclick = async () => {
			this.close();
			const entries = this.entries.map((e) => {
				if (!chosen.has(e)) return e;
				const source = chosen.get(e) as number | null;
				const last = this.vaults.map((v) => this.plugin.settings.last[v.path]?.[e.item.id]);
				// A conflict the user settled is no longer one, so the sync records it.
				return { ...e, source, targets: source === null ? [] : targetsFor(e.sides, last, source), conflict: source === null && e.conflict };
			});
			await this.plugin.apply(this.vaults, entries, true);
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
