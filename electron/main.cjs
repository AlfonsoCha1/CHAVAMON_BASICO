// Proceso principal de Montoya Studio (escritorio: Windows, macOS, Linux).
// Principios: todo local, sin telemetría, sin red, permisos mínimos, ventana aislada (contextIsolation + sandbox).
'use strict';
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, session, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');

const DEV_URL = process.env.MS_DEV_URL || '';
const DIST = path.join(__dirname, '..', 'dist');
const IS_TEST = process.env.MS_TEST === '1';

// Permite aislar datos en pruebas automáticas.
if (process.env.MS_USER_DATA) app.setPath('userData', process.env.MS_USER_DATA);
const DOCS_ROOT = process.env.MS_DOCS_ROOT || path.join(app.getPath('documents'), 'Montoya Studio');
const PROJECTS = path.join(DOCS_ROOT, 'Proyectos');
const LIBRARY = path.join(DOCS_ROOT, 'Biblioteca');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (!IS_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
}

/** Rutas externas que el usuario eligió (o que referencian sus proyectos). Solo esas se sirven. */
const allowedExternal = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.srt': 'text/plain; charset=utf-8',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

function within(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Respuesta de archivo con soporte de rangos (necesario para buscar dentro de videos). */
async function fileResponse(filePath, request) {
  let st;
  try {
    st = await fsp.stat(filePath);
    if (!st.isFile()) throw new Error('no file');
  } catch {
    return new Response('No encontrado', { status: 404 });
  }
  const size = st.size;
  const range = request.headers.get('range');
  const headers = { 'Content-Type': mimeOf(filePath), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
    end = Math.min(end, size - 1);
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

function projectDir(id) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Identificador de proyecto inválido');
  return path.join(PROJECTS, id);
}

function resolveMediaUrl(urlStr) {
  const u = new URL(urlStr);
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (u.host === 'project') {
    const dir = projectDir(parts[0]);
    const p = path.join(dir, ...parts.slice(1));
    return within(dir, p) ? p : null;
  }
  if (u.host === 'library') {
    const p = path.join(LIBRARY, ...parts);
    return within(LIBRARY, p) ? p : null;
  }
  if (u.host === 'external') {
    // la ruta absoluta completa viaja codificada en un único segmento
    const p = path.resolve(decodeURIComponent(u.pathname.slice(1)));
    return allowedExternal.has(p) ? p : null;
  }
  return null;
}

async function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

function registerExternalRefs(projectRaw) {
  try {
    for (const a of Object.values(projectRaw.media || {})) {
      if (a && a.ref && a.ref.type === 'external' && typeof a.ref.path === 'string') allowedExternal.add(path.resolve(a.ref.path));
    }
  } catch { /* ignorar */ }
}

const FILTERS = {
  video: [{ name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }],
  image: [{ name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
  audio: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'] }],
  font: [{ name: 'Fuentes', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
  pack: [{ name: 'Paquete Montoya', extensions: ['mspack', 'json'] }],
  subtitle: [{ name: 'Subtítulos SRT', extensions: ['srt'] }],
  visual: [{ name: 'Video o imagen', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'jpg', 'jpeg', 'png', 'webp', 'gif'] }],
  media: [{ name: 'Video, imagen o audio', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'] }],
};

const exportsOpen = new Map();
const openHandles = new Map();
let exportSeq = 0;
let win = null;
let closeConfirmed = false;

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => fn(...args));

  h('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch, docsRoot: DOCS_ROOT }));

  // ----- proyectos -----
  h('projects:list', async () => {
    await fsp.mkdir(PROJECTS, { recursive: true });
    const out = [];
    for (const name of await fsp.readdir(PROJECTS)) {
      try {
        out.push(await readJson(path.join(PROJECTS, name, 'summary.json')));
      } catch { /* sin resumen */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  });
  h('projects:read', async (id) => {
    const f = path.join(projectDir(id), 'project.json');
    try {
      const raw = await readJson(f);
      registerExternalRefs(raw);
      return { raw, fromBackup: false };
    } catch {
      const raw = await readJson(f + '.bak');
      registerExternalRefs(raw);
      return { raw, fromBackup: true };
    }
  });
  h('projects:write', async (id, json, summaryJson) => {
    const dir = projectDir(id);
    await fsp.mkdir(path.join(dir, 'media'), { recursive: true });
    const f = path.join(dir, 'project.json');
    try {
      const prev = await fsp.readFile(f, 'utf8');
      JSON.parse(prev);
      await atomicWrite(f + '.bak', prev);
    } catch { /* primer guardado o anterior dañado */ }
    await atomicWrite(f, json);
    await atomicWrite(path.join(dir, 'summary.json'), summaryJson);
    return true;
  });
  h('projects:thumb', async (id, bytes) => {
    await atomicWrite(path.join(projectDir(id), 'thumb.jpg'), Buffer.from(bytes));
    return true;
  });
  h('projects:delete', async (id) => {
    const dir = projectDir(id);
    try {
      await shell.trashItem(dir); // a la papelera del sistema: recuperable
    } catch {
      await fsp.rm(dir, { recursive: true, force: true });
    }
    return true;
  });
  h('projects:copyFiles', async (from, to) => {
    const a = projectDir(from);
    const b = projectDir(to);
    await fsp.mkdir(b, { recursive: true });
    await fsp.cp(path.join(a, 'media'), path.join(b, 'media'), { recursive: true }).catch(() => {});
    await fsp.copyFile(path.join(a, 'thumb.jpg'), path.join(b, 'thumb.jpg')).catch(() => {});
    return true;
  });
  h('projects:reveal', async (id) => {
    await shell.openPath(projectDir(id));
    return true;
  });
  h('session:open', async (id) => { await fsp.writeFile(path.join(projectDir(id), '.session'), String(Date.now())); return true; });
  h('session:close', async (id) => { await fsp.rm(path.join(projectDir(id), '.session'), { force: true }); return true; });
  h('session:unclean', async () => {
    const out = [];
    try {
      for (const name of await fsp.readdir(PROJECTS)) if (fs.existsSync(path.join(PROJECTS, name, '.session'))) out.push(name);
    } catch { /* */ }
    return out;
  });

  // ----- medios -----
  h('files:pick', async (kind, multiple) => {
    // Solo pruebas automáticas: cola de archivos simulando el selector del sistema.
    if (IS_TEST && process.env.MS_PICK_FILE) {
      const q = JSON.parse(fs.readFileSync(process.env.MS_PICK_FILE, 'utf8'));
      const next = q.shift() || [];
      fs.writeFileSync(process.env.MS_PICK_FILE, JSON.stringify(q));
      const out = [];
      for (const p of next) {
        const st = await fsp.stat(p);
        allowedExternal.add(path.resolve(p));
        out.push({ name: path.basename(p), size: st.size, mime: mimeOf(p).split(';')[0], path: path.resolve(p) });
      }
      return out;
    }
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', ...(multiple ? ['multiSelections'] : [])], filters: FILTERS[kind] || FILTERS.media });
    if (r.canceled) return [];
    const out = [];
    for (const p of r.filePaths) {
      const st = await fsp.stat(p);
      const abs = path.resolve(p);
      allowedExternal.add(abs);
      out.push({ name: path.basename(p), size: st.size, mime: mimeOf(p).split(';')[0], path: abs });
    }
    return out;
  });
  h('files:allowDropped', async (paths) => {
    const out = [];
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, 200)) {
      if (typeof p !== 'string' || !p) continue;
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) continue;
        const abs = path.resolve(p);
        allowedExternal.add(abs);
        out.push({ name: path.basename(abs), size: st.size, mime: mimeOf(abs).split(';')[0], path: abs });
      } catch { /* */ }
    }
    return out;
  });
  h('files:readBytes', async (p, max) => {
    const abs = path.resolve(p);
    if (!allowedExternal.has(abs)) throw new Error('Archivo no autorizado');
    const fh = await fsp.open(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(max, (await fh.stat()).size));
      await fh.read(buf, 0, buf.length, 0);
      return new Uint8Array(buf);
    } finally { await fh.close(); }
  });
  h('media:copyIn', async (projectId, srcPath, relPath) => {
    const abs = path.resolve(srcPath);
    if (!allowedExternal.has(abs)) throw new Error('Archivo no autorizado');
    const dir = projectDir(projectId);
    const dest = path.join(dir, relPath);
    if (!within(dir, dest)) throw new Error('Ruta inválida');
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const st = await fsp.stat(abs);
    const free = await freeBytes(dir);
    if (free !== null && free < st.size * 1.05 + 50e6) throw new Error(`Espacio insuficiente en disco para copiar ${(st.size / 1048576).toFixed(0)} MB.`);
    await fsp.copyFile(abs, dest + '.part');
    await fsp.rename(dest + '.part', dest);
    return true;
  });
  h('media:exists', async (url) => {
    const p = resolveMediaUrl(url);
    return !!p && fs.existsSync(p);
  });
  h('media:allow', async (p) => { allowedExternal.add(path.resolve(p)); return true; });
  // Lectura directa por rangos (más rápida que fetch por protocolo para el análisis y la decodificación).
  h('media:size', async (url) => {
    const p = resolveMediaUrl(url);
    if (!p) throw new Error('No autorizado o no encontrado');
    return (await fsp.stat(p)).size;
  });
  h('media:read', async (url, start, end) => {
    const p = resolveMediaUrl(url);
    if (!p) throw new Error('No autorizado o no encontrado');
    let fh = openHandles.get(p);
    if (!fh) {
      fh = await fsp.open(p, 'r');
      openHandles.set(p, fh);
      if (openHandles.size > 24) {
        const [k, v] = openHandles.entries().next().value;
        openHandles.delete(k);
        v.close().catch(() => {});
      }
    }
    const len = Math.max(0, end - start);
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  });

  // ----- exportación -----
  h('export:pick', async (suggested) => {
    const dir = path.join(app.getPath('videos'), 'Montoya Studio');
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    if (IS_TEST && process.env.MS_EXPORT_DIR) {
      return { name: suggested, path: path.join(process.env.MS_EXPORT_DIR, suggested) };
    }
    const r = await dialog.showSaveDialog(win, {
      title: 'Guardar video',
      defaultPath: path.join(dir, suggested),
      filters: [{ name: 'Video MP4', extensions: ['mp4'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (r.canceled || !r.filePath) return null;
    let p = r.filePath;
    if (!/\.mp4$/i.test(p)) p += '.mp4';
    return { name: path.basename(p), path: p };
  });
  h('export:exists', async (p) => fs.existsSync(p));
  h('export:open', async (p) => {
    const id = ++exportSeq;
    const tmp = p + '.part';
    const fh = await fsp.open(tmp, 'w');
    exportsOpen.set(id, { fh, tmp, final: p });
    return id;
  });
  h('export:write', async (id, position, data) => {
    const e = exportsOpen.get(id);
    if (!e) throw new Error('Exportación no abierta');
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await e.fh.write(buf, off, buf.length - off, position + off);
      off += bytesWritten;
    }
    return true;
  });
  h('export:finish', async (id) => {
    const e = exportsOpen.get(id);
    if (!e) throw new Error('Exportación no abierta');
    await e.fh.sync();
    await e.fh.close();
    exportsOpen.delete(id);
    await fsp.rename(e.tmp, e.final);
    allowedExternal.add(path.resolve(e.final));
    return true;
  });
  h('export:abort', async (id) => {
    const e = exportsOpen.get(id);
    if (!e) return true;
    try { await e.fh.close(); } catch { /* */ }
    exportsOpen.delete(id);
    await fsp.rm(e.tmp, { force: true });
    return true;
  });
  h('fs:free', async (p) => freeBytes(p ? path.dirname(p) : DOCS_ROOT));
  h('shell:reveal', async (p) => { shell.showItemInFolder(p); return true; });
  h('shell:open', async (p) => { const err = await shell.openPath(p); return !err; });

  // ----- texto -----
  h('text:save', async (suggested, content, ext) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), suggested), filters: [{ name: ext.toUpperCase(), extensions: [ext] }], properties: ['showOverwriteConfirmation'] });
    if (r.canceled || !r.filePath) return false;
    await atomicWrite(r.filePath, content);
    return true;
  });

  // ----- biblioteca -----
  h('library:list', async () => {
    try { return await readJson(path.join(LIBRARY, 'library.json')); } catch { return []; }
  });
  h('library:add', async (entry, srcPath) => {
    const abs = path.resolve(srcPath);
    if (!allowedExternal.has(abs)) throw new Error('Archivo no autorizado');
    await fsp.mkdir(LIBRARY, { recursive: true });
    if (!/^[A-Za-z0-9_.-]+$/.test(entry.file)) throw new Error('Nombre inválido');
    await fsp.copyFile(abs, path.join(LIBRARY, entry.file));
    let list = [];
    try { list = await readJson(path.join(LIBRARY, 'library.json')); } catch { /* */ }
    list.push(entry);
    await atomicWrite(path.join(LIBRARY, 'library.json'), JSON.stringify(list, null, 1));
    return entry;
  });
  h('library:remove', async (id) => {
    let list = [];
    try { list = await readJson(path.join(LIBRARY, 'library.json')); } catch { /* */ }
    const e = list.find((x) => x.id === id);
    if (e && /^[A-Za-z0-9_.-]+$/.test(e.file)) await fsp.rm(path.join(LIBRARY, e.file), { force: true });
    await atomicWrite(path.join(LIBRARY, 'library.json'), JSON.stringify(list.filter((x) => x.id !== id), null, 1));
    return true;
  });
  h('library:bytes', async (file) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(file)) throw new Error('Nombre inválido');
    return new Uint8Array(await fsp.readFile(path.join(LIBRARY, file)));
  });

  // ----- ajustes -----
  h('settings:get', async () => { try { return await readJson(SETTINGS_FILE); } catch { return null; } });
  h('settings:set', async (s) => { await fsp.mkdir(path.dirname(SETTINGS_FILE), { recursive: true }); await atomicWrite(SETTINGS_FILE, JSON.stringify(s, null, 1)); return true; });
  h('storage:info', async () => ({ location: DOCS_ROOT, free: await freeBytes(DOCS_ROOT) }));

  h('app:closeOk', async () => { closeConfirmed = true; if (win) win.close(); return true; });
}

async function freeBytes(dir) {
  if (IS_TEST && process.env.MS_FAKE_FREE) return Number(process.env.MS_FAKE_FREE);
  try {
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function lockDownSession() {
  const ses = session.defaultSession;
  // Sin red: se bloquea cualquier petición http(s)/ws salvo el servidor de desarrollo local.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    if (/^(https?|wss?):/i.test(u)) {
      if (DEV_URL && (u.startsWith(DEV_URL) || /^wss?:\/\/localhost/.test(u))) return cb({});
      console.warn('[seguridad] petición de red bloqueada:', u);
      return cb({ cancel: true });
    }
    cb({});
  });
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen' || permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
  try { ses.setSpellCheckerEnabled(false); } catch { /* */ } // evita descargar diccionarios
}

function createWindow() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon-512.png'));
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 360,
    minHeight: 600,
    backgroundColor: '#070b1a',
    title: 'Montoya Studio',
    icon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Abrir el video exportado en su visor (blob:) no aplica en escritorio; cualquier otra apertura se bloquea.
    console.warn('[seguridad] ventana bloqueada:', url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://') && !(DEV_URL && url.startsWith(DEV_URL))) e.preventDefault();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] proceso terminado', details.reason);
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) setTimeout(() => win.reload(), 500);
  });
  win.on('close', (e) => {
    if (closeConfirmed || IS_TEST) return;
    e.preventDefault();
    win.webContents.send('app:closeRequest');
    setTimeout(() => { closeConfirmed = true; if (win && !win.isDestroyed()) win.close(); }, 5000);
  });
  win.on('closed', () => { win = null; });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadURL('app://local/index.html');
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  if (!isMac) {
    // Windows/Linux: la app ya trae su propia barra (Archivo, Editar, Ver…); sin menú nativo duplicado.
    // Copiar/pegar en campos de texto sigue funcionando (lo maneja Chromium).
    Menu.setApplicationMenu(null);
    return;
  }
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Archivo', submenu: [isMac ? { role: 'close', label: 'Cerrar ventana' } : { role: 'quit', label: 'Salir' }] },
    { label: 'Editar', submenu: [{ role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' }] },
    { label: 'Ver', submenu: [{ role: 'resetZoom', label: 'Tamaño real' }, { role: 'zoomIn', label: 'Acercar' }, { role: 'zoomOut', label: 'Alejar' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Pantalla completa' }, ...(DEV_URL ? [{ role: 'toggleDevTools' }] : [])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  await fsp.mkdir(PROJECTS, { recursive: true });
  await fsp.mkdir(LIBRARY, { recursive: true });
  protocol.handle('app', (request) => {
    const u = new URL(request.url);
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const p = path.join(DIST, rel);
    if (!within(DIST, p)) return new Response('Prohibido', { status: 403 });
    return fileResponse(p, request);
  });
  protocol.handle('media', (request) => {
    let p = null;
    try { p = resolveMediaUrl(request.url); } catch { p = null; }
    if (!p) return new Response('No autorizado o no encontrado', { status: 404 });
    return fileResponse(p, request);
  });
  lockDownSession();
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  // Limpia temporales de exportaciones abiertas.
  for (const e of exportsOpen.values()) { try { e.fh.close(); fs.rmSync(e.tmp, { force: true }); } catch { /* */ } }
  if (process.platform !== 'darwin' || IS_TEST) app.quit();
});
