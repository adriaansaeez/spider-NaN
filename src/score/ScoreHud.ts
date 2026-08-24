import { t, resolveTrickName, type TrickName } from '../i18n/i18n';
import { SCORE_TUNING as T } from './tuning';

/**
 * OWNER: score-builder. The Tony-Hawk-style overlay: big rolling total and
 * multiplier top-centre, named tricks fading under it, record in the corner.
 *
 * Two rules it has to respect:
 *  - `pointer-events: none` everywhere (see index.html) or it eats the click
 *    that acquires pointer lock;
 *  - the DOM is only written every Nth frame AND only when the text actually
 *    changed, because a per-frame innerHTML write is a real cost at 120 fps.
 *
 * The count-up is display-only: `display` chases `target` and never feeds back
 * into the model, so the animation cannot change a replay's score.
 */
export class ScoreHud {
  private readonly root = document.createElement('div');
  private readonly valueEl = document.createElement('div');
  private readonly multEl = document.createElement('div');
  private readonly tricksEl = document.createElement('div');
  private readonly recordEl = document.createElement('div');

  private display = 0;
  private tick = 0;
  private lastScoreText = '';
  private lastMultText = '';
  private lastRecordText = '';
  private visible = true;

  constructor() {
    this.root.id = 'score-hud';
    this.valueEl.id = 'score-value';
    this.multEl.id = 'score-mult';
    this.tricksEl.id = 'score-tricks';
    this.root.append(this.valueEl, this.multEl, this.tricksEl);
    this.recordEl.id = 'score-record';
    document.body.append(this.root, this.recordEl);
    this.valueEl.textContent = '0';
    this.recordEl.textContent = `${t('hud.best')} 0`;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
    this.recordEl.style.display = v ? '' : 'none';
  }

  /** Snap the roll back to zero — used by reset(), so a screenshot is clean. */
  snap(score: number): void {
    this.display = score;
    this.tick = 0;
  }

  /**
   * @param dt   simulation delta (never wall-clock: a replay must animate the
   *             same way it plays).
   * @param combo true while a run is live; drives the "hot" styling.
   */
  update(dt: number, score: number, multiplier: number, record: number, combo: boolean): void {
    if (!this.visible) return;

    // Exponential ease with a linear floor: responsive on small deltas, but a
    // 40k jump still lands in well under a second instead of asymptoting.
    const diff = score - this.display;
    if (diff !== 0) {
      const ease = 1 - Math.exp(-T.countUpRate * dt);
      const step = Math.max(Math.abs(diff) * ease, T.countUpFloor * dt);
      this.display += Math.sign(diff) * Math.min(Math.abs(diff), step);
      if (Math.abs(score - this.display) < 0.5) this.display = score;
    }

    if (++this.tick % T.domEveryNFrames) return;

    const scoreText = Math.round(this.display).toLocaleString('en-US');
    if (scoreText !== this.lastScoreText) {
      this.valueEl.textContent = scoreText;
      this.lastScoreText = scoreText;
    }
    const multText = multiplier > 1 ? `x${multiplier}` : '';
    if (multText !== this.lastMultText) {
      this.multEl.textContent = multText;
      this.lastMultText = multText;
    }
    const recordText = `${t('hud.best')} ${Math.round(record).toLocaleString('en-US')}`;
    if (recordText !== this.lastRecordText) {
      this.recordEl.textContent = recordText;
      this.lastRecordText = recordText;
    }
    this.root.classList.toggle('is-hot', combo && score > 0);
  }

  /**
   * Push a named trick. The fade is a CSS animation rather than a per-frame
   * opacity write, so a long chain costs one element creation per trick and
   * nothing at all in between.
   */
  pushTrick(trick: TrickName, points: number, big: boolean): void {
    const name = resolveTrickName(trick);
    const el = document.createElement('div');
    el.className = big ? 'score-trick is-big' : 'score-trick';
    el.textContent = `${name} +${points.toLocaleString('en-US')}`;
    el.addEventListener('animationend', () => el.remove(), { once: true });
    this.tricksEl.prepend(el);
    while (this.tricksEl.childElementCount > 4) this.tricksEl.lastElementChild?.remove();
  }

  /** Run banked. Shows the final total once, in its own colour. */
  pushBank(total: number, isRecord: boolean): void {
    const el = document.createElement('div');
    el.className = isRecord ? 'score-bank is-record' : 'score-bank';
    el.textContent = isRecord
      ? `NEW BEST! ${Math.round(total).toLocaleString('en-US')}`
      : `RUN ${Math.round(total).toLocaleString('en-US')}`;
    el.addEventListener('animationend', () => el.remove(), { once: true });
    this.tricksEl.prepend(el);
  }

  dispose(): void {
    this.root.remove();
    this.recordEl.remove();
  }
}
