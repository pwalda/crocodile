# Distribution without code-signing certificates (for now)

Operating systems warn about apps from developers they can't identify. The
real fix is code signing, which costs money (Apple) or needs an established
identity (Windows). Until then, these are the ways around it, from best to
worst, and what the release pipeline already does.

## Summary

| Platform | What users get today                                                                                  | Friction-free path without a certificate         | Proper fix                                                               |
| -------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| Windows  | Unsigned per-user installer. Downloaded from a browser, SmartScreen says "Windows protected your PC". | `install.ps1` one-liner, winget, Microsoft Store | SignPath Foundation (free for open source) or Azure Trusted Signing      |
| macOS    | Ad-hoc signed universal app. Downloaded from a browser, Gatekeeper blocks the first launch.           | `install.sh` one-liner                           | Apple Developer Program ($99/year) → Developer ID signing + notarization |
| Linux    | AppImage, .deb, .rpm, .tar.gz. No signing warnings.                                                   | `install.sh` one-liner                           | Flathub listing (nice to have)                                           |

## One-line installers (work today)

```sh
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.ps1 | iex
```

Files fetched by `curl` or PowerShell are not tagged as "downloaded from the
internet" (no quarantine attribute on macOS, no Mark-of-the-Web on Windows),
so Gatekeeper and SmartScreen do not interrupt. The scripts only download the
official release assets from GitHub over HTTPS. The website offers them next
to the regular download buttons.

## Windows

- **Browser download (unsigned):** SmartScreen shows "Windows protected your
  PC" → _More info_ → _Run anyway_. The warning fades as a file builds
  reputation, but every new version starts from zero.
- **winget:** submit a manifest to `microsoft/winget-pkgs` pointing at the
  release installer (`wingetcreate new <url>`). Users run
  `winget install Crocodile.Crocodile`. winget installs do not go through the
  browser SmartScreen prompt. Automate updates with `wingetcreate update` in
  the release workflow.
- **Microsoft Store:** individual developer accounts are free. Build an MSIX
  (`appx` target in electron-builder) and submit it; the Store signs the
  package. Note: Store builds should disable the built-in auto-updater (the
  Store updates them).
- **SignPath Foundation:** free Authenticode signing for open-source
  projects, integrated with GitHub Actions (it requires a public repository
  with a licence and releases). This is the recommended long-term fix for the
  direct download.
- **Azure Trusted Signing:** low monthly cost, but requires identity
  validation and has eligibility restrictions; check current availability.

When a certificate exists, set `CSC_LINK` / `CSC_KEY_PASSWORD` (or the
provider's action) in the release workflow; nothing else changes.

## macOS

- Builds are **ad-hoc signed** (`identity: '-'` in
  `apps/desktop/electron-builder.config.cjs`). That is required for Apple
  Silicon to launch the app at all, but it does not satisfy Gatekeeper.
- **Browser download:** the first launch is blocked. On macOS 15 and later:
  try to open the app once, then _System Settings → Privacy & Security →
  Open Anyway_. After that it opens normally.
- **`install.sh`:** no prompt at all (see above).
- **Auto-update:** Squirrel.Mac refuses updates that are not signed with a
  Developer ID, so ad-hoc builds show a notification with a download link
  instead of updating silently (`checkForUpdates` in `src/main/main.ts`). The
  build records whether it was properly signed (`crocSigned` in the packaged
  `package.json`).
- **Homebrew:** a tap (`pwalda/homebrew-crocodile`) with a cask is easy to
  maintain, but Homebrew is phasing out casks that fail Gatekeeper, so treat
  it as a convenience for signed builds rather than a workaround.
- **Proper fix:** the Apple Developer Program (99 USD/year) gives a Developer
  ID certificate. Set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as repository secrets and
  the release workflow signs, enables the hardened runtime and notarizes
  automatically. This is the one platform with no free equivalent.

## Linux

- No signing prompts. `install.sh` uses the `.deb` with apt, the `.rpm` with
  dnf/zypper, and falls back to an AppImage in `~/.local/bin` (AppImages need
  `libfuse2`, missing by default on some recent distributions).
- The `.deb` and `.rpm` configure Chromium's sandbox helper correctly, which
  matters on distributions that restrict unprivileged user namespaces
  (Ubuntu 24.04+). Prefer them over the tarball.
- **Flathub** would give Crocodile a place in GNOME Software and KDE
  Discover. It needs a Flatpak manifest (`org.electronjs.Electron2.BaseApp`)
  and the portals for global shortcuts (Wayland) — worth doing together with
  Wayland push-to-talk support.

## Global push-to-talk permissions

- **macOS:** the first time push-to-talk is enabled, macOS asks for the
  Accessibility permission (System Settings → Privacy & Security →
  Accessibility). Without it, push-to-talk works while Crocodile is focused.
  Ad-hoc signed builds lose this permission on every update because their
  signature changes; Developer ID builds keep it.
- **Linux:** needs X11 (or XWayland focus). Pure Wayland sessions fall back to
  in-window push-to-talk until the XDG GlobalShortcuts portal is supported.
- **Windows:** works without any prompt.
