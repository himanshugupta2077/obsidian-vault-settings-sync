import { FileSystemAdapter, Modal, Notice, Plugin, ViewState, WorkspaceLeaf } from "obsidian";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Action, backup, copyItem, discover, Entry, expandHome, Item, plan, Policy, pruneBackups } from "./engine";
import { SyncSettingTab } from "./settings";

export interface Settings {
	/** The shared folder every vault syncs through. `~` is allowed. */
	hubPath: string;
	syncOnStartup: boolean;
	/** Minutes between automatic syncs; 0 turns them off. */
	intervalMinutes: number;
	policy: Policy;
	/** Reload Obsidian by itself when pulled settings need it. */
	autoReload: boolean;
	/** Item key → picked. Missing keys use the item's default. */
	selected: Record<string, boolean>;
	/** Item id → the hash both sides had after this vault last synced it. */
	last: Record<string, string>;
	/** The hub `last` refers to. Changing the hub forgets it. */
	lastHub: string;
}

const DEFAULTS: Settings = {
	hubPath: "",
	syncOnStartup: true,
	intervalMinutes: 0,
	policy: "ask",
	autoReload: false,
	selected: {},
	last: {},
	lastHub: "",
};

const KEEP_BACKUPS = 10;

/** Obsidian internals the plugin uses to restart a plugin after pulling its settings. */
interface InternalApp {
	plugins: {
		enabledPlugins: Set<string>;
		disablePlugin(id: string): Promise<void>;
		enablePlugin(id: string): Promise<void>;
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
		this.settings = { ...DEFAULTS, ...(await this.loadData()) };
		this.addSettingTab(new SyncSettingTab(this.app, this));
		this.addRibbonIcon("refresh-cw", "Sync settings", () => this.sync(true));
		this.addCommand({ id: "sync", name: "Sync now", callback: () => this.sync(true) });
		this.addCommand({ id: "preview", name: "Preview sync", callback: () => this.preview() });
		this.addCommand({ id: "push-all", name: "Push everything picked to the hub (overwrite hub)", callback: () => this.force("push") });
		this.addCommand({ id: "pull-all", name: "Pull everything picked from the hub (overwrite this vault)", callback: () => this.force("pull") });
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

	get localRoot(): string {
		return join((this.app.vault.adapter as FileSystemAdapter).getBasePath(), this.app.vault.configDir);
	}

	get hubRoot(): string {
		return expandHome(this.settings.hubPath.trim());
	}

	private get internal(): InternalApp {
		return this.app as unknown as InternalApp;
	}

	items(): Item[] {
		return discover(this.localRoot, this.hubRoot, this.manifest.id);
	}

	isSelected(item: Item): boolean {
		return this.settings.selected[item.key] ?? item.defaultOn;
	}

	/** The plan for every item, picked or not. Null when no hub is set. */
	planAll(): Entry[] | null {
		if (!this.settings.hubPath.trim()) return null;
		if (this.settings.lastHub !== this.hubRoot) {
			this.settings.last = {};
			this.settings.lastHub = this.hubRoot;
		}
		return plan(this.localRoot, this.hubRoot, this.items(), this.settings.last, this.settings.policy);
	}

	/** The plan for the picked items, or null with a reason when there is nothing to sync against. */
	private ready(manual: boolean): Entry[] | null {
		if (!this.settings.hubPath.trim()) {
			if (manual) new Notice("Settings sync: choose a hub folder in the plugin settings first.");
			return null;
		}
		// An automatic run never creates the hub: its drive may just not be mounted yet.
		if (!existsSync(this.hubRoot)) {
			if (!manual) return null;
			mkdirSync(this.hubRoot, { recursive: true });
		}
		return (this.planAll() ?? []).filter((e) => this.isSelected(e.item));
	}

	async sync(manual: boolean): Promise<void> {
		const entries = this.ready(manual);
		if (!entries) return;
		await this.apply(entries, manual);
		const conflicts = entries.filter((e) => e.action === "skip").length;
		if (conflicts) {
			const frag = createFragment((f) => {
				f.appendText(`Settings sync: ${conflicts} item${conflicts > 1 ? "s" : ""} changed here and in the hub. `);
				f.createEl("a", { text: "Choose which to keep", href: "#" }).onclick = () => this.preview();
			});
			new Notice(frag, 0);
		}
	}

	preview(): void {
		const entries = this.ready(true);
		if (entries) new PreviewModal(this, entries).open();
	}

	private async force(action: "push" | "pull"): Promise<void> {
		const entries = this.ready(true);
		if (!entries) return;
		const side = action === "push" ? "local" : "hub";
		await this.apply(
			entries.map((e) => ({ ...e, action: e.local.hash === e.hub.hash || !e[side].hash ? "none" : action })),
			true,
		);
	}

	/** Carry out each entry's action. */
	async apply(entries: Entry[], manual: boolean): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const failed: string[] = [];
		let pushed = 0;
		let pulled = 0;
		let needsReload = false;
		try {
			const local = this.localRoot;
			const hub = this.hubRoot;
			for (const e of entries) {
				if (e.action === "none" && e.local.hash) this.settings.last[e.item.id] = e.local.hash;
				if (e.action !== "push") continue;
				try {
					copyItem(local, hub, e.item);
					this.settings.last[e.item.id] = e.local.hash;
					pushed++;
				} catch (err) {
					failed.push(`${e.item.label}: ${(err as Error).message}`);
				}
			}

			const pulls = entries.filter((e) => e.action === "pull");
			if (pulls.length) {
				// Stop a running plugin before replacing its settings, so it can't save its old ones
				// over them on the way out, and start it again to load the new ones.
				const plugins = this.internal.plugins;
				const restart = [...new Set(pulls.map((e) => e.item.plugin))].filter((id): id is string => !!id && plugins.enabledPlugins.has(id));
				// Disabling a plugin turns its open tabs into blank placeholders; note what they showed.
				const tabs = new Map<WorkspaceLeaf, ViewState>();
				if (restart.length) this.app.workspace.iterateAllLeaves((leaf) => {
					tabs.set(leaf, leaf.getViewState());
				});
				for (const id of restart) await plugins.disablePlugin(id);
				const gone = new Set([...tabs.values()].map((v) => v.type).filter((t) => !this.internal.viewRegistry.getViewCreatorByType(t)));

				const backups = join(local, "plugins", this.manifest.id, "backups");
				const dir = join(backups, new Date().toISOString().replace(/[:.]/g, "-"));
				for (const e of pulls) {
					try {
						backup(local, e.item, dir);
						copyItem(hub, local, e.item);
						this.settings.last[e.item.id] = e.hub.hash;
						pulled++;
						if (e.item.group !== "plugin") needsReload = true;
					} catch (err) {
						failed.push(`${e.item.label}: ${(err as Error).message}`);
					}
				}
				pruneBackups(backups, KEEP_BACKUPS);

				if (pulls.some((e) => e.item.id.startsWith("plugin-files:"))) await plugins.loadManifests();
				for (const id of restart) await plugins.enablePlugin(id);
				for (const [leaf, view] of tabs) if (gone.has(view.type)) await leaf.setViewState(view);
			}
		} finally {
			this.busy = false;
			await this.save();
		}

		if (failed.length) new Notice(`Settings sync failed for:\n${failed.join("\n")}`, 0);
		if (pushed || pulled) new Notice(`Settings sync: ${[pushed && `pushed ${pushed}`, pulled && `pulled ${pulled}`].filter(Boolean).join(", ")}.`);
		else if (manual && !failed.length) new Notice("Settings sync: everything is in sync.");
		if (needsReload) this.offerReload();
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

const ACTION_LABELS: Record<Exclude<Action, "none">, string> = {
	push: "Push this vault's → hub",
	pull: "Pull hub's → this vault",
	skip: "Skip",
};

/** Lists what a sync would change, and lets the user pick a direction for each item. */
class PreviewModal extends Modal {
	constructor(private plugin: SettingsSyncPlugin, private entries: Entry[]) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Settings sync");
		const changes = this.entries.filter((e) => e.action !== "none");
		const same = this.entries.length - changes.length;
		if (!changes.length) {
			contentEl.createEl("p", { text: `All ${same} picked items are in sync.` });
			return;
		}
		contentEl.createEl("p", { cls: "vss-muted", text: `${same} picked item${same === 1 ? " is" : "s are"} already in sync.` });
		const chosen = new Map<Entry, Action>(changes.map((e) => [e, e.action]));
		const table = contentEl.createDiv({ cls: "vss-preview" });
		for (const e of changes) {
			const row = table.createDiv({ cls: "vss-row" + (e.conflict ? " vss-conflict" : "") });
			const text = row.createDiv({ cls: "vss-row-text" });
			text.createDiv({ text: e.item.group === "plugin" ? `${e.item.label} · ${e.item.id.startsWith("plugin:") ? "settings" : "plugin files"}` : e.item.label });
			text.createDiv({ cls: "vss-muted", text: `${e.reason} · ${e.item.detail}` });
			const select = row.createEl("select", { cls: "dropdown" });
			for (const a of ["push", "pull", "skip"] as const) {
				// Can't push or pull what a side doesn't have.
				if ((a === "push" && !e.local.hash) || (a === "pull" && !e.hub.hash)) continue;
				select.createEl("option", { value: a, text: ACTION_LABELS[a] });
			}
			select.value = e.action;
			select.onchange = () => chosen.set(e, select.value as Action);
		}
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		const go = buttons.createEl("button", { text: "Sync", cls: "mod-cta" });
		go.onclick = async () => {
			this.close();
			await this.plugin.apply(this.entries.map((e) => ({ ...e, action: chosen.get(e) ?? e.action })), true);
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
