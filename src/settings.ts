import { App, PluginSettingTab, Setting } from "obsidian";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import type { Entry, Policy } from "./engine";
import type SettingsSyncPlugin from "./main";

const STATUS: Record<string, { text: string; cls: string }> = {
	none: { text: "In sync", cls: "vss-ok" },
	push: { text: "Will push", cls: "vss-push" },
	pull: { text: "Will pull", cls: "vss-pull" },
	skip: { text: "Conflict", cls: "vss-warn" },
};

export class SyncSettingTab extends PluginSettingTab {
	private filter = "";

	constructor(app: App, private plugin: SettingsSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const plugin = this.plugin;
		const s = plugin.settings;
		containerEl.empty();
		containerEl.addClass("vss-settings");

		const hubDesc = createFragment((f) => {
			f.appendText("A folder every vault can reach, such as one in iCloud Drive or Dropbox. Each vault you want to share settings with points here. ");
			f.createEl("br");
			f.createSpan({ cls: "vss-muted", text: this.hubState() });
		});
		new Setting(containerEl)
			.setName("Hub folder")
			.setDesc(hubDesc)
			.addText((t) =>
				t
					.setPlaceholder("~/Library/Mobile Documents/com~apple~CloudDocs/Obsidian settings")
					.setValue(s.hubPath)
					.onChange(async (v) => {
						s.hubPath = v.trim();
						await plugin.save();
					}),
			)
			.addExtraButton((b) => b.setIcon("rotate-cw").setTooltip("Check folder").onClick(() => this.display()));

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
			.setName("When an item changed in both places")
			.setDesc("Ask shows the item in the preview so you pick. Automatic syncs leave it alone until then.")
			.addDropdown((d) =>
				d
					.addOptions({ ask: "Ask me", newest: "Keep the newest", local: "Keep this vault's", hub: "Keep the hub's" })
					.setValue(s.policy)
					.onChange(async (v) => {
						s.policy = v as Policy;
						await plugin.save();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Reload automatically")
			.setDesc("Plugin settings apply straight away. Editor, appearance, hotkey and enabled-plugin settings need Obsidian to reload; off asks first.")
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
			entries = plugin.planAll() ?? plugin.items().map((item) => ({ item }) as Entry);
		} catch (err) {
			containerEl.createEl("p", { cls: "vss-warn", text: `Could not read the hub: ${(err as Error).message}` });
			entries = plugin.items().map((item) => ({ item }) as Entry);
		}
		const byId = new Map(entries.map((e) => [e.item.id, e]));


		const core = entries.filter((e) => e.item.group === "core");
		this.section("Obsidian settings", "Each file in your config folder. Open tabs and workspace layouts never sync.", core.map((e) => e.item.key));
		for (const e of core) this.itemRow(e.item.label, e.item.detail, e.item.key, [e]);

		const themes = entries.filter((e) => e.item.key === "themes");
		const snippets = entries.filter((e) => e.item.key === "snippets");
		this.section("Themes & snippets", "Vaults end up with every theme and snippet any of them has.", ["themes", "snippets"]);
		this.itemRow("Themes", this.count(themes, "theme"), "themes", themes);
		this.itemRow("CSS snippets", this.count(snippets, "snippet"), "snippets", snippets);

		const plugins = entries.filter((e) => e.item.group === "plugin").map((e) => e.item);
		this.section(
			"Community plugins",
			"Settings copies the plugin's data.json, which can hold API keys, into the hub folder. Plugin files copies the plugin itself, so it gets installed or updated in your other vaults.",
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
		const ids = [...new Set(plugins.map((i) => i.plugin as string))];
		for (const id of ids) this.pluginRow(id, byId);
	}

	private hubState(): string {
		const p = this.plugin;
		if (!p.settings.hubPath.trim()) return "Not set yet.";
		const hub = p.hubRoot;
		const rel = relative(p.localRoot, hub);
		if (!rel || !rel.startsWith("..")) return "⚠ This folder is inside this vault's config folder; pick one outside it.";
		return existsSync(hub) ? `Found: ${hub}` : `Not found. Sync now creates it: ${hub}`;
	}

	private count(entries: Entry[], noun: string): string {
		const here = entries.filter((e) => e.local?.hash).length;
		const hub = entries.filter((e) => e.hub?.hash).length;
		const n = (k: number) => `${k} ${noun}${k === 1 ? "" : "s"}`;
		return this.plugin.settings.hubPath.trim() ? `${n(here)} here, ${n(hub)} in the hub` : `${n(here)} here`;
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

	/** A badge for the most pressing action among the picked entries. */
	private status(el: HTMLElement, entries: (Entry | undefined)[]): void {
		const picked = entries.filter((e): e is Entry => !!e?.action && this.plugin.isSelected(e.item) && !!(e.local.hash || e.hub.hash));
		const e = ["skip", "pull", "push", "none"].map((a) => picked.find((p) => p.action === a)).find(Boolean);
		if (!e) return;
		const st = STATUS[e.action];
		el.createSpan({ cls: `vss-badge ${st.cls}`, text: st.text, attr: { title: e.reason } });
	}

	private itemRow(label: string, detail: string, key: string, entries: Entry[]): void {
		const setting = new Setting(this.containerEl).setName(label).setDesc(detail);
		this.status(setting.nameEl, entries);
		setting.addToggle((t) => t.setValue(this.plugin.settings.selected[key] ?? entries[0]?.item.defaultOn ?? true).onChange(async (v) => {
			this.plugin.settings.selected[key] = v;
			await this.plugin.save();
			this.display();
		}));
	}

	private pluginRow(id: string, byId: Map<string, Entry>): void {
		const data = byId.get(`plugin:${id}`);
		const code = byId.get(`plugin-files:${id}`);
		if (!data || !code) return;
		const where = !code.local?.hash && code.hub?.hash ? "Only in the hub · " : "";
		const setting = new Setting(this.containerEl).setName(data.item.label).setDesc(`${where}${id}`);
		setting.settingEl.addClass("vss-plugin-row");
		setting.settingEl.dataset.search = `${data.item.label} ${id}`.toLowerCase();
		if (this.filter && !setting.settingEl.dataset.search.includes(this.filter)) setting.settingEl.hide();
		this.status(setting.nameEl, [data, code]);
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
