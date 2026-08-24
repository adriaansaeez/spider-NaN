# Web Slinger — spider-NaN

Juego de balanceo con telarañas sobre una ciudad procedural, hecho en **Three.js + TypeScript + Vite**, acompañado de una **página de presentación** que documenta todo el proceso de construcción.

El proyecto se construyó con un **gauntlet loop de agentes IA**: agentes constructores especializados por sistema (ciudad, físicas de balanceo, cámara, animación, audio, UI) y agentes **críticos independientes** que juzgaban el render real contra referencias visuales concretas, devolviendo al constructor con debilidades nombradas. Build → render → inspect → critique → improve, en bucle.

**Modelos usados:** Opus 5 · DeepSeek V4 Flash · GPT-5.5

---

## Cómo ejecutarlo

### Docker (recomendado)

```bash
docker build -t spider-nan .
docker run -p 8080:80 spider-nan
```

- Juego → <http://localhost:8080/>
- Presentación → <http://localhost:8080/presentacion/>

### Desarrollo local

```bash
npm ci
npm run dev      # http://localhost:5173
```

### Build de producción

```bash
npm run build    # tsc --noEmit && vite build → dist/
npm run preview  # http://localhost:4173
```

> `npm run dev` / `npm run preview` sirven el juego. La presentación se sirve desde `presentacion/index.html` y referencia media con rutas `../`, por lo que se ve completa en el build de Docker (donde `presentacion/`, `captures/`, `docs/` y `reference-pack/` quedan como hermanos en la raíz servida).

---

## Controles

| Acción | Tecla |
|---|---|
| Dirigir / moverse | `WASD` |
| Mirar | Ratón |
| Lanzar telaraña | `Clic izquierdo` o `E` |
| Dash / impulso | `Clic derecho` o `Shift` |
| Picado (dive) | `S` o `Ctrl` |
| Saltar / lanzarse | `Espacio` |

---

## La presentación

`/presentacion/` recorre el proceso completo: los dos loops de construcción, la ciudad procedural, el ciclo día/noche, las comparativas de animación contra referencia, las métricas y la evidencia capturada automáticamente en cada iteración.

---

## Estructura

```
index.html            entrada del juego
src/                  código del juego
  core/               Game, Renderer, HUD, telemetría
  city/               generación procedural, cielo, día/noche
  swing/              físicas de balanceo y anclajes
  camera/  input/  fx/  score/  ui/  i18n/
public/assets/        modelo, texturas, audio, vídeo
presentacion/         página de presentación
captures/ docs/ reference-pack/   media referenciada por la presentación
Dockerfile            build multi-stage → nginx
```

---

## Licencia

MIT — © 2026 Adrián Sáez. Ver [LICENSE](LICENSE).
