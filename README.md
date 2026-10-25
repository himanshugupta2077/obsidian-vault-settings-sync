# Vault Settings Sync

Use more than one Obsidian vault without setting each one up by hand. Settings, hotkeys, themes, CSS snippets and the community plugins you pick stay the same in every vault.

Every vault points at one shared **hub folder**, for example a folder in iCloud Drive or Dropbox, or just a local folder. Each vault pushes its changes to the hub and pulls changes made in your other vaults. The hub is laid out like a `.obsidian` folder, so you can open it and read it.

```
Personal vault ─┐                 ┌─ Work vault
                ├──  Hub folder  ──┤
Writing vault  ─┘                 └─ Laptop vault (via iCloud)
```

## What you can sync

You choose what syncs in each vault, item by item.

| | Default |
|---|---|
| **Obsidian settings**: editor & files (`app.json`), appearance, hotkeys, enabled core plugins, graph, property types, and the settings of each core plugin (daily notes, templates…) | on |
| **Enabled community plugins** (`community-plugins.json`) | off, because it turns plugins on and off everywhere |
| **Themes** and **CSS snippets** | on |
| **Each community plugin's settings** (`data.json`) | off: pick the ones you want |
| **Each community plugin's files** (`main.js`, `manifest.json`, `styles.css`), which installs or updates the plugin in your other vaults | off: pick the ones you want |

These never sync: open tabs, the sidebar layout and saved workspaces (`workspace*.json`), and the plugins' own caches and logs.

## How it decides

For each item, the plugin remembers what the item looked like the last time this vault synced it. That tells it which side changed:

- **Changed in this vault** → push to the hub.
- **Changed in the hub** (by another vault) → pull into this vault.
- **Changed in both** → by default it asks. Open **Preview sync** and pick a side for each item. You can also set it to keep the newest copy, always this vault's, or always the hub's.
- **Only on one side** → copied to the other side. Vaults end up with every theme, snippet and plugin any of them has.

Deletions never spread. If you remove a theme or a plugin in one vault, it stays removed there, but your other vaults and the hub keep it.

## When it runs

- When Obsidian starts (you can turn this off).
- Every 5, 15, 30 or 60 minutes, if you turn that on.
- Whenever you click the ribbon icon or run **Sync now**.

The commands also include **Preview sync**, **Push everything picked to the hub** and **Pull everything picked from the hub**. The last two are for overwriting one side on purpose.

## Applying what it pulls

- **Community plugin settings and files** apply straight away. The plugin stops each affected plugin, swaps the files, and starts it again, and its open tabs come back.
- **Editor, appearance, hotkeys, themes and enabled plugins** apply after Obsidian reloads. A notice offers **Reload now**, or turn on **Reload automatically**.

## Safety

- Before it overwrites anything in a vault, the plugin backs up the old files to `.obsidian/plugins/vault-settings-sync/backups/<time>/`. It keeps the last 10 backups.
- An automatic sync never creates the hub folder. If a cloud drive isn't mounted yet, the sync is skipped.
- Plugin settings can hold API keys and tokens. Only pick plugins whose settings you're happy to have in the hub folder.

## Install

With [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `himanshugupta2077/obsidian-vault-settings-sync`.

By hand: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/himanshugupta2077/obsidian-vault-settings-sync/releases) into `<vault>/.obsidian/plugins/vault-settings-sync/`. Reload Obsidian and turn on **Vault Settings Sync** in **Settings → Community plugins**.

Do this in each vault, set the same hub folder in each, and run **Sync now** in the vault whose setup you like best first.

Desktop only, because the hub folder is read with Node's file system access.

## Develop

```
npm install
npm test
npm run build
```

`VAULTS="/path/to/vault-a:/path/to/vault-b" npm run build` also copies the build into those vaults.

## License

MIT. Copyright (c) 2026 Himanshu Gupta.
