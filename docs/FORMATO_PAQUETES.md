# Formato de paquetes de efectos

Un paquete es un archivo JSON (`.mspack` o `.json`, máximo 512 KB) con efectos de color, plantillas de texto y transiciones. **Es solo datos: la app nunca ejecuta código de un paquete.** Los efectos de otros editores no son compatibles.

> El identificador técnico del formato sigue siendo `montoya-pack` para que los paquetes creados antes del cambio de nombre sigan funcionando.

```json
{
  "format": "montoya-pack",
  "formatVersion": 1,
  "id": "mi-paquete",
  "name": "Mi paquete",
  "version": "1.0.0",
  "author": "Tu nombre",
  "license": "CC0 1.0",
  "effects": [
    { "id": "calido", "name": "Cálido", "adjust": { } }
  ],
  "textTemplates": [
    { "id": "titulo", "name": "Título", "style": { }, "animation": "fade", "sampleText": "Hola" }
  ],
  "transitions": [
    { "id": "negro", "name": "A negro", "type": "fade-black", "duration": 0.6 }
  ]
}
```

## Reglas de validación

- `format` debe ser `montoya-pack` y `formatVersion` debe ser `1`.
- `id` del paquete y de cada elemento: letras, números, `.`, `_` o `-`, empezando por letra o número, hasta 80 caracteres.
- Nombres y textos: se recortan a 60 caracteres y se eliminan `<` y `>`.
- Límites: 200 efectos, 200 plantillas de texto y 100 transiciones por paquete.
- `animation` de texto: `none`, `fade`, `pop`, `slide-up` o `typewriter`.
- `type` de transición: `none`, `fade-black`, `fade-white`, `flash` o `zoom-in`; `duration` entre 0.1 y 3 segundos (0.6 por defecto).
- Los valores de `adjust` (efectos) y `style` (texto) se validan y normalizan al importarlos; lo que no se reconoce se ignora.
- Un paquete sin ningún elemento válido se rechaza.
