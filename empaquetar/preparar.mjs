// Arma la carpeta que empaqueta electron-builder: la app compilada + ícono, sin dependencias de npm
// (la interfaz ya viene empaquetada por Vite dentro de dist/).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destino = path.join(raiz, 'empaquetar', 'app');
fs.rmSync(destino, { recursive: true, force: true });
fs.mkdirSync(path.join(destino, 'build'), { recursive: true });
for (const d of ['dist', 'electron']) fs.cpSync(path.join(raiz, d), path.join(destino, d), { recursive: true });
fs.copyFileSync(path.join(raiz, 'build', 'icon-512.png'), path.join(destino, 'build', 'icon-512.png'));
fs.copyFileSync(path.join(raiz, 'marca', 'iconos', 'chavamon.ico'), path.join(destino, 'build', 'icon.ico'));
const pk = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
delete pk.dependencies;
delete pk.devDependencies;
fs.writeFileSync(path.join(destino, 'package.json'), JSON.stringify(pk, null, 2) + '\n');
console.log('Listo:', destino, '· versión', pk.version);
