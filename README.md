# Vault Settings Sync

Use more than one Obsidian vault without setting each one up by hand. Pick your vaults, pick what to keep the same, and the plugin copies settings straight between them.

```
        ┌──────────── Personal ────────────┐
        │                                  │
      Work  ─────────────────────────  Writing
```

Vaults can live anywhere on your computer, in any folder or on any drive, including folders synced by iCloud or Dropbox.

## Set up

1. Install the plugin in one vault (or in all of them).
2. In **Settings → Vault Settings Sync → Vaults**, add the other vaults. Pick from the vaults Obsidian already knows, or type a folder path.
3. Choose what to sync, then click **Preview** to see what will change, or **Sync now**.

## What you can sync

| | Default |
|---|---|
| **Obsidian settings**: editor & files (`app.json`), hotkeys, enabled core plugins, graph, property types, and each core plugin's settings (daily notes, templates…) | **on** |
| **Appearance**: appearance settings (theme choice, fonts, enabled snippets), themes, CSS snippets and Style Settings | off |
| **Each community plugin's settings** (`data.json`) | off |
| **Each community plugin's version** (`main.js`, `manifest.json`, `styles.css`) | off |

## Appearance

Each vault keeps its own look unless you turn on **Sync appearance**. While it's off, nothing about appearance is copied: not `appearance.json`, not themes or snippets, and not the Style Settings plugin's settings, even if you picked them earlier. Turn it on only if your vaults use the same themes; a theme one vault picks may not exist in another.

## Community plugins

The plugin list shows the plugins installed in **every** vault, each with two switches: **Settings** and **Same version**.

Plugins that only some vaults have are tucked under **Not in every vault**. Each one has an **Install in <vault>** button that copies the plugin from a vault that has it and turns it on there. A vault that's open picks it up straight away; any other vault turns it on the next time it opens. Once a plugin is in every vault, it moves up to the main list, where you can sync its settings.

Syncing never installs a plugin by itself. A plugin's settings and version only go to vaults that already have it.

These never sync: open tabs, the sidebar layout and saved workspaces (`workspace*.json`), the list of enabled community plugins (each vault keeps its own), and the plugins' own caches and logs.

## How it decides

For each item, the plugin remembers what each vault's copy looked like the last time it synced. That tells it which vault changed the item:

- **One vault changed it** → its copy goes to all the other vaults.
- **A vault doesn't have it** → that vault gets a copy. Vaults end up with every theme and snippet, if you picked them.
- **Several vaults changed it, or the vaults differ the first time they sync** → it asks. Open **Preview** and choose whose copy to keep. You can also set it to keep the newest copy, or always this vault's.

Deletions never spread. If you remove a snippet or theme from one vault, it stays removed there, and the other vaults keep theirs.

## When it runs

- When Obsidian starts (you can turn this off).
- Every 5, 15, 30 or 60 minutes, if you turn that on.
- Whenever you click the ribbon icon or run **Sync now**.

**Preview sync** shows each change before it happens. **Make every vault match this one** copies everything you picked from the current vault to all the others.

## Applying changes

- Changes to the **vault you're in**:
  - Community plugin settings and files apply straight away. The plugin stops each affected plugin, swaps its files and starts it again.
  - Editor, appearance, hotkeys and themes apply after a reload. A notice offers **Reload now**, or turn on **Reload automatically**.
- Changes to **another vault**:
  - If that vault is closed, it sees them the next time it opens.
  - If it's open, Obsidian picks up most settings files as they change.

## Safety

- Before it overwrites anything, the plugin backs up the old files, from every vault, to `.obsidian/plugins/vault-settings-sync/backups/<time>/<vault>/` in the vault running the sync. It keeps the last 10 backups.
- A vault that can't be found (for example, on a drive that isn't plugged in) is skipped.
- Plugin settings can hold API keys and tokens. Picking a plugin's settings copies them into each of your vaults.

## Install

With [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `himanshugupta2077/obsidian-vault-settings-sync`.

By hand: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/himanshugupta2077/obsidian-vault-settings-sync/releases) into `<vault>/.obsidian/plugins/vault-settings-sync/`. Then reload Obsidian and turn on **Vault Settings Sync** in **Settings → Community plugins**.

Desktop only, because it reads other vaults' folders directly.

## Develop

```
npm install
npm test
npm run build
```

`VAULTS="/path/to/vault-a:/path/to/vault-b" npm run build` also copies the build into those vaults.

## License

MIT. Copyright (c) 2026 Himanshu Gupta.
