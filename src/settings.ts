import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Entry, expandHome, knownVaults, Policy, Vault } from "./engine";
import type SettingsSyncPlugin from "./main";

export class SyncSettingTab extends PluginSettingTab {
	private filter = "";
	private typed = "";

	constructor(app: App, private plugin: SettingsSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const plugin = this.plugin;
		const s = plugin.settings;
		containerEl.empty();
		containerEl.addClass("vss-settings");

		const { vaults, missing } = plugin.vaults();
		this.vaultSection(vaults, missing);

		new Setting(containerEl).setName("Syncing").setHeading();
		new Setting(containerEl)
			.setName("Sync when Obsidian starts")
			.addToggle((t) => t.setValue(s.syncOnStartup).onChange(async (v) => {
				s.syncOnStartup = v;
				await plugin.save();
			}));

		new Setting(containerEl)
			.setName("Sync automatically")
			.setDesc("Also sync in the background while Obsidian is open.")
			.addDropdown((d) =>
				d
					.addOptions({ "0": "Off", "5": "Every 5 minutes", "15": "Every 15 minutes", "30": "Every 30 minutes", "60": "Every hour" })
					.setValue(String(s.intervalMinutes))
					.onChange(async (v) => {
						s.intervalMinutes = Number(v);
						plugin.schedule();
						await plugin.save();
					}),
			);

		new Setting(containerEl)
			.setName("When more than one vault changed the same thing")
			.setDesc("Ask lists it in Preview so you pick. Until then automatic syncs leave it alone.")
			.addDropdown((d) =>
				d
					.addOptions({ ask: "Ask me", newest: "Keep the newest", this: "Keep this vault's" })
					.setValue(s.policy)
					.onChange(async (v) => {
						s.policy = v as Policy;
						await plugin.save();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Reload automatically")
			.setDesc("Plugin settings apply straight away. Editor, appearance, hotkey and theme changes need Obsidian to reload; off asks first.")
			.addToggle((t) => t.setValue(s.autoReload).onChange(async (v) => {
				s.autoReload = v;
				await plugin.save();
			}));

		new Setting(containerEl)
			.addButton((b) => b.setButtonText("Preview").onClick(() => plugin.preview()))
			.addButton((b) => b.setButtonText("Sync now").setCta().onClick(async () => {
				await plugin.sync(true);
				this.display();
			}));

		let entries: Entry[] = [];
		try {
			entries = plugin.planAll(vaults);
		} catch (err) {
			containerEl.createEl("p", { cls: "vss-warn", text: `Could not read a vault's settings: ${(err as Error).message}` });
		}
		const byId = new Map(entries.map((e) => [e.item.id, e]));

		const core = entries.filter((e) => e.item.group === "core");
		this.section("Obsidian settings", "Each settings file in the config folder. Open tabs and workspace layouts never sync.", core.map((e) => e.item.key));
		for (const e of core) this.itemRow(e.item.label, e.item.detail, e.item.key, [e], vaults);

		const themes = entries.filter((e) => e.item.key === "themes");
		const snippets = entries.filter((e) => e.item.key === "snippets");
		this.section("Themes & snippets", "Every vault ends up with every theme and snippet any of them has.", ["themes", "snippets"]);
		this.itemRow("Themes", this.count(themes, "theme", vaults), "themes", themes, vaults);
		this.itemRow("CSS snippets", this.count(snippets, "snippet", vaults), "snippets", snippets, vaults);

		const plugins = entries.filter((e) => e.item.group === "plugin").map((e) => e.item);
		this.section(
			"Community plugins",
			"Settings copies the plugin's options (its data.json, which can hold API keys). Plugin files copies the plugin itself, so it gets installed or updated in the other vaults.",
			plugins.map((i) => i.key),
		);
		if (plugins.length > 12) {
			new Setting(containerEl).addSearch((q) =>
				q.setPlaceholder("Filter plugins…").setValue(this.filter).onChange((v) => {
					this.filter = v.toLowerCase();
					containerEl.querySelectorAll<HTMLElement>(".vss-plugin-row").forEach((el) => {
						el.toggle(!this.filter || (el.dataset.search ?? "").includes(this.filter));
					});
				}),
			);
		}
		for (const id of [...new Set(plugins.map((i) => i.plugin as string))]) this.pluginRow(id, byId, vaults);
	}

	private vaultSection(vaults: Vault[], missing: string[]): void {
		const { containerEl } = this;
		const plugin = this.plugin;
		const s = plugin.settings;
		new Setting(containerEl)
			.setName("Vaults")
			.setDesc("The vaults to keep in step with this one. Syncing copies settings straight between their config folders.")
			.setHeading();

		new Setting(containerEl).setName(vaults[0].name).setDesc(vaults[0].path);
		for (const raw of s.vaults) {
			const path = resolve(expandHome(raw));
			const found = vaults.find((v) => v.path === path);
			const row = new Setting(containerEl).setName(found?.name ?? path.split(/[\\/]/).pop() ?? path);
			row.setDesc(missing.includes(path) ? `⚠ Not found right now: ${path}` : path);
			row.addExtraButton((b) =>
				b.setIcon("x").setTooltip("Stop syncing with this vault").onClick(async () => {
					s.vaults = s.vaults.filter((v) => v !== raw);
					delete s.last[path];
					await plugin.save();
					this.display();
				}),
			);
		}

		const linked = new Set([vaults[0].path, ...s.vaults.map((v) => resolve(expandHome(v)))]);
		const add = async (raw: string) => {
			const path = resolve(expandHome(raw.trim()));
			if (!raw.trim()) return;
			if (linked.has(path)) return new Notice("That vault is already in the list.");
			if (!existsSync(join(path, this.app.vault.configDir))) return new Notice(`No ${this.app.vault.configDir} folder in ${path}. Is it a vault?`);
			s.vaults.push(path);
			this.typed = "";
			await plugin.save();
			this.display();
		};

		const known = knownVaults().filter((p) => !linked.has(resolve(p)));
		if (known.length) {
			let pick = known[0];
			new Setting(containerEl)
				.setName("Add a vault")
				.setDesc("Vaults Obsidian has opened on this computer.")
				.addDropdown((d) => {
					for (const p of known) d.addOption(p, p);
					d.onChange((v) => (pick = v));
				})
				.addButton((b) => b.setButtonText("Add").onClick(() => add(pick)));
		}
		new Setting(containerEl)
			.setName(known.length ? "Or add a folder" : "Add a vault")
			.setDesc("The vault's folder, the one that holds its notes and its config folder.")
			.addText((t) => t.setPlaceholder("~/Documents/Work vault").setValue(this.typed).onChange((v) => (this.typed = v)))
			.addButton((b) => b.setButtonText("Add").onClick(() => add(this.typed)));
	}

	private count(entries: Entry[], noun: string, vaults: Vault[]): string {
		const n = (k: number) => `${k} ${noun}${k === 1 ? "" : "s"}`;
		return vaults.map((v, i) => `${v.name}: ${n(entries.filter((e) => e.sides[i].hash).length)}`).join(" · ");
	}

	/** A heading with buttons that pick or unpick every item under it. */
	private section(name: string, desc: string, keys: string[]): void {
		const h = new Setting(this.containerEl).setName(name).setHeading();
		if (desc) h.setDesc(desc);
		const setAll = async (on: boolean, only?: string) => {
			for (const k of keys) if (!only || k.startsWith(only)) this.plugin.settings.selected[k] = on;
			await this.plugin.save();
			this.display();
		};
		if (keys[0]?.startsWith("plugin")) {
			h.addButton((b) => b.setButtonText("All settings").onClick(() => setAll(true, "plugin:")));
			h.addButton((b) => b.setButtonText("All files").onClick(() => setAll(true, "plugin-files:")));
		} else h.addButton((b) => b.setButtonText("All").onClick(() => setAll(true)));
		h.addButton((b) => b.setButtonText("None").onClick(() => setAll(false)));
	}

	/** A badge for the most pressing state among the picked entries. */
	private status(el: HTMLElement, entries: (Entry | undefined)[], vaults: Vault[]): void {
		if (vaults.length < 2) return;
		const picked = entries.filter((e): e is Entry => !!e && this.plugin.isSelected(e.item) && e.sides.some((s) => s.hash));
		if (!picked.length) return;
		const conflict = picked.find((e) => e.conflict && e.source === null);
		const targets = [...new Set(picked.flatMap((e) => e.targets))];
		const [text, cls, title] = conflict
			? ["Conflict", "vss-warn", conflict.reason]
			: targets.length
				? [`Will update ${targets.map((t) => vaults[t].name).join(", ")}`, "vss-push", picked.find((e) => e.targets.length)?.reason ?? ""]
				: ["In sync", "vss-ok", ""];
		el.createSpan({ cls: `vss-badge ${cls}`, text, attr: { title } });
	}

	private itemRow(label: string, detail: string, key: string, entries: Entry[], vaults: Vault[]): void {
		const setting = new Setting(this.containerEl).setName(label).setDesc(detail);
		this.status(setting.nameEl, entries, vaults);
		setting.addToggle((t) => t.setValue(this.plugin.settings.selected[key] ?? entries[0]?.item.defaultOn ?? false).onChange(async (v) => {
			this.plugin.settings.selected[key] = v;
			await this.plugin.save();
			this.display();
		}));
	}

	private pluginRow(id: string, byId: Map<string, Entry>, vaults: Vault[]): void {
		const data = byId.get(`plugin:${id}`);
		const code = byId.get(`plugin-files:${id}`);
		if (!data || !code) return;
		const where = vaults.filter((_, i) => code.sides[i].hash).map((v) => v.name);
		const setting = new Setting(this.containerEl).setName(data.item.label).setDesc(`${id} · installed in ${where.join(", ") || "none"}`);
		setting.settingEl.addClass("vss-plugin-row");
		setting.settingEl.dataset.search = `${data.item.label} ${id}`.toLowerCase();
		if (this.filter && !setting.settingEl.dataset.search.includes(this.filter)) setting.settingEl.hide();
		this.status(setting.nameEl, [data, code], vaults);
		for (const [entry, label] of [[data, "Settings"], [code, "Plugin files"]] as const) {
			setting.controlEl.createSpan({ cls: "vss-toggle-label", text: label });
			setting.addToggle((t) => t.setValue(this.plugin.isSelected(entry.item)).onChange(async (v) => {
				this.plugin.settings.selected[entry.item.key] = v;
				await this.plugin.save();
				this.display();
			}));
		}
	}
}
