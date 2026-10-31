# dsh-auto-i18n

Translates Chinese interface text from installed DeepSeek Harness plugins into English while you use the web UI.

Most third-party DSH plugins ship Chinese labels, menus, and settings without an English locale. This plugin translates the rendered text in place, so it works with hardcoded strings too, not only with plugins that provide locale files.

## Install

Install this directory as a bundle with the Harness plugin manager, either from the Plugins page or with the `plugin_manager` tool (`install_bundle`). The plugin market also accepts a GitHub source: point it at `https://github.com/x01Jin/dsh-auto-i18n`.

The bundle mounts the shipped translation service `@deepseek-ai/dsh-experimental-translator`, so nothing else needs to be installed.

## Use

Open Settings, then General, and find the Auto translate switch.

Translation is on by default. The switch turns it off and restores the original text without a reload. The choice is kept in browser localStorage.

## What gets translated

- Buttons, labels, menu items, setting rows, dialogs, tooltips, placeholders, and card text.
- Short descriptions in the plugin market and plugin manager.

Skipped on purpose:

- `pre`, `code`, and `kbd` content, to protect code and commands.
- Text areas and contenteditable editors.
- Text inside markdown-rendered content, including chat messages and plugin README bodies. This avoids translating partially streamed output and mangling formatted documents.
- CodeMirror and Monaco editor content.

## How it works

A client half walks the page, collects text nodes and the `placeholder`, `title`, `aria-label`, and `alt` attributes that contain Chinese, batches up to 24 strings, and posts them to a host route. The host translates through Google first and falls back to Bing, keeps a cache at `$DSH_HOME/auto-i18n-cache.json` (default `~/.dsh/auto-i18n-cache.json`), and returns the results. The client keeps a browser-side cache, so the next page load renders translated text without network calls.

A MutationObserver translates nodes added later, such as panels opened after boot. React re-renders can overwrite a translation; the observer reapplies it from cache.

## Privacy

Text selected for translation is sent to Google's or Bing's anonymous translate endpoints through the Harness translator service. No API key or account is used. Results are cached locally; nothing else is stored or sent.

## Limitations

- Machine translation without surrounding context. Short labels are usually clear; longer sentences can read poorly.
- One request per unique string on first encounter. A page with many Chinese labels takes a few seconds to settle.
- If both providers fail, strings stay untranslated for that session.
- Translation applies to the web UI only.

## Requirements

- DeepSeek Harness 0.2.1-rc.5 or newer, web UI.
- Node.js 22.19+ or 24+, matching the runtime bundled with Desktop.
- Network access to the translation endpoints.

## Files

- `index.js`: host half, translation route, provider calls, disk cache.
- `client.js`: DOM scan, batching, browser cache, settings row.
- `cordis.patch.yml`: inserts the translator service row and the plugin row.

## Development

Check syntax before installing:

```
node --check index.js
node --check client.js
```

Install the working copy as a bundle and reload the page. Client changes need a page reload; host changes need a plugin reinstall or an app restart.

## License

MIT
