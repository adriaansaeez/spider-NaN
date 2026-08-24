import type { PlayerSnapshot } from '../contracts';
import { GLOBALS } from '../contracts/globals';
import type { PerfReport } from './Telemetry';

/** LEAD-OWNED debug HUD. Critics hide it with __GAUNTLET__.setHudVisible(false). */
export class Hud {
  private el = document.createElement('div');
  private tick = 0;

  constructor() {
    this.el.id = 'hud';
    document.body.appendChild(this.el);
  }

  setVisible(v: boolean) { this.el.style.display = v ? 'block' : 'none'; }

  update(perf: PerfReport, p: PlayerSnapshot, buildings: number) {
    if (this.el.style.display === 'none') return;
    if (++this.tick % 10) return;
    const b = GLOBALS.budget;
    const warn = (ok: boolean) => (ok ? '' : ' class="bad"');
    this.el.innerHTML = `
<b>${perf.fps} fps</b> <span${warn(perf.frameMsP95 <= b.maxFrameMs)}>p95 ${perf.frameMsP95}ms</span>
<span${warn(perf.drawCalls <= b.maxDrawCalls)}>draws ${perf.drawCalls}</span>
tris ${(perf.triangles / 1000).toFixed(0)}k
${perf.jsHeapMb !== null
        ? `heap ${perf.jsHeapMb}mb`
        // Say so on screen rather than silently dropping the row: a missing heap
        // reading and a frozen one look identical otherwise.
        : `heap <span class="bad">n/a</span>${perf.jsHeapRawMb !== null ? ` (${perf.jsHeapRawMb}mb frozen)` : ''}`}
geo ${perf.geometries}
<br><b>${p.state}</b> ${p.speed.toFixed(0)} m/s · alt ${p.altitude.toFixed(0)}m · rope ${p.ropeLength.toFixed(0)}m
<br>buildings ${buildings} · load ${perf.loadMs}ms`;
  }
}
