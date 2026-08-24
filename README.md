# Web Slinger — spider-NaN

A web-swinging game over a procedural city, built with **Three.js + TypeScript + Vite**, shipped alongside a **presentation site** documenting the entire construction process.

The project was built with an **AI agent gauntlet loop**: specialized builder agents per system (city, swing physics, camera, animation, audio, UI) and independent **critic agents** judging the actual render against concrete visual references, sending the builder back with named weaknesses. Build → render → inspect → critique → improve, in a loop.

**Models used:** Opus 5 · DeepSeek V4 Flash · GPT-5.5

---

## How to run

### Docker (recommended)

```bash
docker build -t spider-nan .
docker run -p 8080:80 spider-nan
```

- Game → <http://localhost:8080/>
- Presentation → <http://localhost:8080/presentacion/>

### Local development

```bash
npm ci
npm run dev      # http://localhost:5173
```

### Production build

```bash
npm run build    # tsc --noEmit && vite build → dist/
npm run preview  # http://localhost:4173
```

> `npm run dev` / `npm run preview` serve the game. The presentation is served from `presentacion/index.html` and references media with `../` paths, so it displays in full in the Docker build (where `presentacion/`, `captures/`, `docs/` and `reference-pack/` sit as siblings at the served root).

---

## Controls

| Action | Key |
|---|---|
| Steer / move | `WASD` |
| Look | Mouse |
| Shoot web | `Left click` or `E` |
| Dash / boost | `Right click` or `Shift` |
| Dive | `S` or `Ctrl` |
| Jump / launch | `Space` |

---

## The presentation

`/presentacion/` walks through the whole process: both construction loops, the procedural city, the day/night cycle, animation comparisons against reference footage, and the metrics and evidence captured automatically on every iteration. (UI available in Spanish and English — toggle it in the nav.)

---

## Structure

```
index.html            game entry point
src/                  game source
  core/               Game, Renderer, HUD, telemetry
  city/               procedural generation, sky, day/night
  swing/              swing physics and anchors
  camera/  input/  fx/  score/  ui/  i18n/
public/assets/        model, textures, audio, video
presentacion/         presentation site
captures/ docs/ reference-pack/   media referenced by the presentation
Dockerfile            multi-stage build → nginx
```

---

## License

MIT — © 2026 Adrián Sáez. See [LICENSE](LICENSE).
