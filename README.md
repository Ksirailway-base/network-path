<p align="center"><img src="src/assets/brand/app.svg" width="88" alt="Network-path"></p>

<h1 align="center">Network-path</h1>
<p align="center"><strong>One path. Two endpoints.</strong></p>
<p align="center">Inspect browser traffic. Record sessions. Understand APIs.</p>

Network-path is a desktop HTTP, HTTPS, and WebSocket inspector built with Tauri and Rust. It connects to Chromium through the Chrome DevTools Protocol, without a MITM proxy or a custom CA certificate.

## Features

- **Traffic inspector** — request and response headers, bodies, timing, initiators, filters, and GraphQL operation names.
- **Sessions** — save captures, import HAR files, search previous sessions, and compare API endpoints between runs.
- **Sitemap** — explore hosts, group dynamic URL paths, and export an endpoint map.
- **Repeater** — edit and resend HTTP requests using the native HTTP client.
- **Intercept and mocks** — pause requests, edit URLs and headers, drop requests, or substitute responses.
- **Export and code generation** — HAR, Postman, OpenAPI, CSV, JSON, Python scraper scaffolds, and copy-as cURL, Python, or JavaScript.
- **Workspace** — dark and light themes, compact rows, persistent filters, and a system tray icon.

## Getting started

**Windows preview.** macOS and Linux packaging targets are configured, but platform support is still in progress.

Install Node.js, Rust, MSVC Build Tools with the Windows SDK, and WebView2 Runtime. Then, from the project directory:

```sh
npm ci
npm start
```

### Browser extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose the `extension` directory.
3. Open a page and start capture from the extension or desktop app.
4. Wait for **Recording**, then generate traffic.

Capture follows the active HTTP(S) tab. Switching tabs keeps the same session; requests to third-party hosts made by that tab are included. **Clear View** clears the table without deleting saved files.

Chrome, Edge, Brave, Vivaldi, Opera, and Yandex browser paths are supported by Windows discovery. Firefox and Safari are not supported.

### Without an extension

**Capture without extension** launches a separate browser profile and connects over the local debugging port. This mode is experimental; it does not yet have full feature parity with the extension.

## Build

```sh
npm run build
```

Installers are written to `src-tauri/target/release/bundle/`. Application and tray icons are included in the source tree.

## Current limitations

This is an early release. Use a separate browser profile for testing and keep important captures backed up.

- Capture recovery, disk-write error reporting, and Intercept completion reporting are still being hardened.
- The local bridge is not yet hardened for untrusted environments.
- WebSocket frames are read-only. TLS fingerprints are not measured.
- Repeater uses its own HTTP client rather than the browser's cookies or TLS session; response bodies are limited to 5 MiB.
- Captures and exports may contain credentials or personal data. Review them before sharing.
- Media previews may contact the original URL when a saved body is unavailable.

## License

[MIT](LICENSE) © 2026 [Ksirailway-base](https://github.com/Ksirailway-base).
