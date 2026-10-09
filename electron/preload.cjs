// Puente mínimo y con lista blanca entre la interfaz y el proceso principal.
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNELS = new Set([
  'app:info', 'app:closeOk',
  'projects:list', 'projects:read', 'projects:write', 'projects:thumb', 'projects:delete', 'projects:copyFiles', 'projects:reveal',
  'session:open', 'session:close', 'session:unclean',
  'files:pick', 'files:readBytes', 'files:allowDropped', 'media:copyIn', 'media:exists', 'media:allow', 'media:size', 'media:read',
  'export:pick', 'export:exists', 'export:open', 'export:write', 'export:finish', 'export:abort',
  'fs:free', 'shell:reveal', 'shell:open', 'text:save',
  'library:list', 'library:add', 'library:remove', 'library:bytes',
  'settings:get', 'settings:set', 'storage:info',
]);

contextBridge.exposeInMainWorld('montoya', {
  platform: process.platform,
  invoke(channel, ...args) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error('Canal no permitido: ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  /** Ruta de un archivo soltado sobre la ventana (arrastrar y soltar). */
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  onCloseRequest(cb) {
    ipcRenderer.on('app:closeRequest', () => cb());
  },
});
