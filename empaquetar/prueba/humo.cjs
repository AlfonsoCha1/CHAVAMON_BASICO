// Prueba de humo de un CHAVAMON ya empaquetado (Windows o Linux):
// abre la app, crea un proyecto, importa un clip y exporta un MP4.
// Uso: node humo.cjs <ruta-al-ejecutable> <carpeta-temporal>
const { _electron } = require('playwright');
const fs = require('fs');
const path = require('path');

const [exe, tmp] = process.argv.slice(2);
const datos = path.resolve(tmp);
fs.mkdirSync(path.join(datos, 'exportados'), { recursive: true });
const pick = path.join(datos, 'pick.json');
fs.writeFileSync(pick, JSON.stringify([[path.join(__dirname, 'clip.mp4')]]));
const res = [];
const check = (n, ok, d = '') => { res.push(ok); console.log(`${ok ? 'OK   ' : 'FALLA'} ${n}${d ? ' — ' + d : ''}`); };

(async () => {
  const app = await _electron.launch({
    executablePath: exe,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    env: { ...process.env, MS_TEST: '1', MS_USER_DATA: path.join(datos, 'ajustes'), MS_DOCS_ROOT: path.join(datos, 'documentos'), MS_PICK_FILE: pick, MS_EXPORT_DIR: path.join(datos, 'exportados') },
    timeout: 120000,
  });
  const win = await app.firstWindow();
  await win.waitForTimeout(3000);
  check('título de la ventana', (await win.title()) === 'CHAVAMON', await win.title());
  const info = await win.evaluate(() => window.montoya.invoke('app:info'));
  check('versión y plataforma', !!info.version, `${info.version} · ${info.platform} ${info.arch} · Electron ${info.electron}`);
  await win.getByRole('button', { name: 'Nuevo proyecto' }).first().click();
  await win.locator('form input.input').fill('Prueba de humo');
  await win.getByRole('button', { name: 'Crear y abrir' }).click();
  await win.waitForTimeout(1500);
  await win.getByRole('button', { name: 'Agregar video o foto' }).click();
  await win.waitForTimeout(5000);
  check('importa el clip a la línea de tiempo', (await win.locator('text=clip.mp4').count()) > 0);
  await win.getByRole('button', { name: 'Exportar', exact: true }).click();
  await win.getByRole('button', { name: '720p' }).click();
  await win.getByRole('button', { name: 'Guardar video' }).click();
  const dir = path.join(datos, 'exportados');
  let mp4 = null;
  for (let i = 0; i < 240 && !mp4; i++) { mp4 = fs.readdirSync(dir).find((n) => n.endsWith('.mp4')); if (!mp4) await win.waitForTimeout(500); }
  await win.waitForTimeout(800);
  const tam = mp4 ? fs.statSync(path.join(dir, mp4)).size : 0;
  check('exporta un MP4', tam > 50000, mp4 ? `${mp4} · ${tam} bytes` : 'sin archivo');
  await win.screenshot({ path: path.join(datos, 'captura.png') });
  await app.close();
  const fallas = res.filter((x) => !x).length;
  console.log(`\n${res.length - fallas}/${res.length} correctas`);
  process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
