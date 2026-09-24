// Pick the right download for this visitor and show install commands for
// this site. Everything degrades to plain links without JavaScript.
(() => {
  const REPO = 'pwalda/crocodile';
  const ua = navigator.userAgent;
  const os = /Windows/i.test(ua)
    ? 'windows'
    : /Mac OS X|Macintosh/i.test(ua)
      ? 'mac'
      : /Linux|X11/i.test(ua) && !/Android/i.test(ua)
        ? 'linux'
        : null;
  const names = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
  const button = document.getElementById('download');
  const note = document.getElementById('download-note');

  if (os && button) {
    button.textContent = `Download for ${names[os]}`;
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((release) => {
        const assets = (release.assets || []).filter((a) => !/blockmap|\.yml$/.test(a.name));
        const pick = (re) => assets.find((a) => re.test(a.name));
        const asset =
          os === 'windows'
            ? pick(/\.exe$/)
            : os === 'mac'
              ? pick(/\.dmg$/)
              : pick(/(x86_64|x64|amd64).*\.AppImage$|\.AppImage$/);
        if (!asset) return;
        button.href = asset.browser_download_url;
        if (note)
          note.textContent = `Version ${release.tag_name.replace(/^v/, '')} · ${asset.name}`;
      })
      .catch(() => {});
  }

  // Serve the install scripts from this site when it's the main server.
  if (location.protocol === 'https:') {
    const sh = document.getElementById('cmd-sh');
    const ps = document.getElementById('cmd-ps');
    if (sh) sh.textContent = `curl -fsSL ${location.origin}/install.sh | sh`;
    if (ps) ps.textContent = `irm ${location.origin}/install.ps1 | iex`;
  }

  for (const b of document.querySelectorAll('button.copy')) {
    b.addEventListener('click', async () => {
      const text = document.getElementById(b.dataset.copy)?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy'), 1500);
      } catch {
        /* clipboard blocked; the text is selectable */
      }
    });
  }
})();
