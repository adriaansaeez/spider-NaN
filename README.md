# Spider-NaN

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

- Presentation (landing page) → <http://localhost:8080/>
- Game → <http://localhost:8080/game>

### Local development

```bash
npm ci
npm run dev      # http://localhost:5173
```

- Presentation → <http://localhost:5173/>
- Game → <http://localhost:5173/game/>

### Production build

```bash
npm run build    # tsc --noEmit && vite build → dist/
npm run preview  # game at http://localhost:4173/game/
```

> `vite build` emits only the game (under the `/game/` base), so `npm run preview` serves the game and not the presentation. The final `/` + `/game` layout is assembled in the Dockerfile, which moves the bundle to `dist/game/` and drops `presentacion/index.html`, `captures/`, `docs/` and `reference-pack/` at the root.
>
> `npm run dev` mirrors that final layout: a dev-only plugin in `vite.config.ts` serves the presentation at `/` and the media directories at the root, so the presentation's absolute paths (`/game/assets/…`, `/captures/…`) resolve the same in dev as in the container.

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

The landing page at `/` (source: `presentacion/index.html`) walks through the whole process: both construction loops, the procedural city, the day/night cycle, animation comparisons against reference footage, and the metrics and evidence captured automatically on every iteration. (UI available in Spanish and English — toggle it in the nav.)

---

## Structure

```
index.html            game entry point (served at /game/)
src/                  game source
  core/               Game, Renderer, HUD, telemetry
  city/               procedural generation, sky, day/night
  swing/              swing physics and anchors
  camera/  input/  fx/  score/  ui/  i18n/
public/assets/        model, textures, audio, video
presentacion/         presentation site (served at /)
captures/ docs/ reference-pack/   media referenced by the presentation
vite.config.ts        base '/game/' + dev-only mirror of the served layout
Dockerfile            multi-stage build → nginx (/ = presentation, /game = game)
```

---

## License

MIT — © 2026 Adrián Sáez. See [LICENSE](LICENSE).
