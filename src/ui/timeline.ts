import {
  buildPlaybackSequence,
  frameDurationMs,
  resolvePlaybackRange,
  stepPlayback,
} from '../core/animation';
import { getLayerCel } from '../core/doc';
import type { AnimDirection } from '../core/types';
import {
  addAnimationCommand,
  addFrameCommand,
  removeAnimationCommand,
  removeFrameCommand,
  reorderFrameCommand,
  setFrameDurationCommand,
  setLayerFrameCountCommand,
  updateAnimationCommand,
} from '../state/commands';
import type { AppController } from './controller';
import { h } from './dom';
import { icon } from './icons';

export interface TimelineApi {
  el: HTMLElement;
  togglePlay: () => void;
  closePopovers: () => boolean;
  destroy: () => void;
}

function celHasContent(cel: Uint8ClampedArray): boolean {
  for (let i = 3; i < cel.length; i += 4) {
    if (cel[i] > 0) return true;
  }
  return false;
}

export function createTimeline(ctrl: AppController, onExportAnim?: (scope: string) => void): TimelineApi {
  let playRaf = 0;
  let lastTickMs = 0;
  let elapsedMs = 0;
  let seq: number[] = [0];
  let seqIdx = 0;
  let dragFrameFrom = -1;
  let onionSettingsOpen = false;
  let animEditorOpen = false;

  const playBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Play animation',
      'aria-pressed': 'false',
      title: 'Play / Stop (Space when timeline focused)',
      onClick: () => togglePlay(),
    },
    icon('play', 14),
  );

  const syncPlayBtn = (playing: boolean) => {
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.setAttribute('aria-label', playing ? 'Stop animation' : 'Play animation');
    playBtn.replaceChildren(icon(playing ? 'stop' : 'play', 14));
  };

  const stopPlayback = () => {
    if (playRaf) window.cancelAnimationFrame(playRaf);
    playRaf = 0;
    if (ctrl.state.playing) ctrl.store.setState({ playing: false });
    syncPlayBtn(false);
  };

  /** Real-clock playback using performance.now() delta accumulator (no setInterval drift). */
  const playbackStep = (now: number) => {
    const s = ctrl.state;
    if (!s.playing) {
      playRaf = 0;
      return;
    }
    const range = resolvePlaybackRange(s.doc, s.activeAnimationId, s.playDirection, s.playLoop);
    seq = buildPlaybackSequence(range.from, range.to, range.direction);
    if (seqIdx >= seq.length) seqIdx = 0;

    const dt = Math.min(250, Math.max(0, now - lastTickMs));
    lastTickMs = now;
    elapsedMs += dt;

    let dur = frameDurationMs(s.doc, seq[seqIdx]);
    let advanced = false;
    while (elapsedMs >= dur) {
      elapsedMs -= dur;
      const res = stepPlayback(seq, seqIdx, range.loop);
      seqIdx = res.nextSeqIdx;
      if (res.stopped) {
        ctrl.store.setState({ activeFrame: res.frame, playing: false });
        syncPlayBtn(false);
        playRaf = 0;
        return;
      }
      advanced = true;
      dur = frameDurationMs(s.doc, seq[seqIdx]);
    }

    if (advanced) {
      ctrl.store.setState({ activeFrame: seq[seqIdx] });
    }
    playRaf = window.requestAnimationFrame(playbackStep);
  };

  const togglePlay = () => {
    if (ctrl.state.playing) {
      stopPlayback();
      return;
    }
    const s = ctrl.state;
    const range = resolvePlaybackRange(s.doc, s.activeAnimationId, s.playDirection, s.playLoop);
    seq = buildPlaybackSequence(range.from, range.to, range.direction);
    const curPos = seq.indexOf(s.activeFrame);
    seqIdx = curPos >= 0 ? curPos : 0;
    elapsedMs = 0;
    lastTickMs = performance.now();
    ctrl.store.setState({ playing: true, activeFrame: seq[seqIdx] });
    syncPlayBtn(true);
    playRaf = window.requestAnimationFrame(playbackStep);
  };

  const dirSelect = h(
    'select',
    {
      class: 'compact-select',
      'aria-label': 'Playback direction',
      onChange: () => {
        const dir = dirSelect.value as AnimDirection;
        const s = ctrl.state;
        const activeAnim = s.activeAnimationId ? s.doc.animations.find((a) => a.id === s.activeAnimationId) : null;
        if (activeAnim) {
          ctrl.execute(updateAnimationCommand(activeAnim, { ...activeAnim, direction: dir }, 'Animation direction'));
        } else {
          ctrl.store.setState({ playDirection: dir });
        }
      },
    },
    h('option', { value: 'forward' }, 'Forward'),
    h('option', { value: 'reverse' }, 'Reverse'),
    h('option', { value: 'pingpong' }, 'Ping-pong'),
  );

  const loopBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn tiny',
      'aria-label': 'Loop playback',
      'aria-pressed': String(ctrl.state.playLoop),
      title: 'Loop playback',
      onClick: () => {
        const s = ctrl.state;
        const activeAnim = s.activeAnimationId ? s.doc.animations.find((a) => a.id === s.activeAnimationId) : null;
        if (activeAnim) {
          ctrl.execute(updateAnimationCommand(activeAnim, { ...activeAnim, loop: !activeAnim.loop }, 'Animation loop'));
        } else {
          ctrl.store.setState({ playLoop: !s.playLoop });
        }
      },
    },
    icon('repeat', 14),
  );

  const fpsInput = h('input', {
    id: 'timeline-fps',
    class: 'num',
    type: 'number',
    min: 1,
    max: 60,
    value: ctrl.state.doc.fps,
    'aria-label': 'Default FPS',
    onChange: () => {
      const nextFps = Math.min(60, Math.max(1, Math.round(Number(fpsInput.value) || 8)));
      ctrl.state.doc.fps = nextFps;
      fpsInput.value = String(nextFps);
    },
  });

  const delFrameBtn = h('button', {
    type: 'button',
    onClick: () => {
      if (ctrl.state.doc.frames.length <= 1) return;
      ctrl.execute(removeFrameCommand(ctrl.state.activeFrame));
    },
  }, 'Delete');

  // ---- Onion Skin controls (F-ONION) ----
  const onionToggleBtn = h(
    'button',
    {
      type: 'button',
      'aria-pressed': String(ctrl.state.onion.enabled),
      title: 'Toggle onion skin (N)',
      onClick: () => ctrl.toggleOnion(),
    },
    icon('onion', 14),
    ' Onion',
  );
  const onionOptsBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn tiny',
      'aria-label': 'Onion skin settings',
      'aria-expanded': 'false',
      title: 'Onion skin settings',
      onClick: () => {
        onionSettingsOpen = !onionSettingsOpen;
        onionOptsBtn.setAttribute('aria-expanded', String(onionSettingsOpen));
        renderOnionBar();
      },
    },
    icon('sliders', 14),
  );

  const onionBar = h('div', { class: 'onion-bar', hidden: true });
  const renderOnionBar = () => {
    const on = ctrl.state.onion;
    onionToggleBtn.setAttribute('aria-pressed', String(on.enabled));
    onionBar.hidden = !onionSettingsOpen;
    if (!onionSettingsOpen) return;

    const befIn = h('input', {
      type: 'number', class: 'num tiny-num', min: 0, max: 5, value: on.before, 'aria-label': 'Onion frames before',
      onChange: () => ctrl.updateOnion({ before: Math.max(0, Math.min(5, Math.round(Number(befIn.value)))) }),
    });
    const aftIn = h('input', {
      type: 'number', class: 'num tiny-num', min: 0, max: 5, value: on.after, 'aria-label': 'Onion frames after',
      onChange: () => ctrl.updateOnion({ after: Math.max(0, Math.min(5, Math.round(Number(aftIn.value)))) }),
    });

    onionBar.replaceChildren(
      h('span', { class: 'onion-swatch onion-prev-dot', title: 'Previous frame tint (--onion-prev)' }),
      h('span', { class: 'hint' }, 'Prev'),
      befIn,
      h('span', { class: 'onion-swatch onion-next-dot', title: 'Next frame tint (--onion-next)' }),
      h('span', { class: 'hint' }, 'Next'),
      aftIn,
      h('div', { class: 'btn-group' },
        h('button', { type: 'button', 'aria-pressed': String(on.mode === 'tinted'), onClick: () => ctrl.updateOnion({ mode: 'tinted' }) }, 'Tinted'),
        h('button', { type: 'button', 'aria-pressed': String(on.mode === 'original'), onClick: () => ctrl.updateOnion({ mode: 'original' }) }, 'Original'),
      ),
      h('div', { class: 'btn-group' },
        h('button', { type: 'button', 'aria-pressed': String(on.source === 'composed'), onClick: () => ctrl.updateOnion({ source: 'composed' }) }, 'All layers'),
        h('button', { type: 'button', 'aria-pressed': String(on.source === 'active'), onClick: () => ctrl.updateOnion({ source: 'active' }) }, 'Active layer'),
      ),
      h('button', { type: 'button', 'aria-pressed': String(on.wrap), onClick: () => ctrl.updateOnion({ wrap: !on.wrap }) }, 'Wrap'),
    );
  };

  // ---- Named Animations ----
  const animSelect = h('select', {
    class: 'compact-select',
    'aria-label': 'Named animation',
    onChange: () => {
      const id = animSelect.value || null;
      ctrl.store.setState({ activeAnimationId: id });
      if (id) {
        const anim = ctrl.state.doc.animations.find((a) => a.id === id);
        if (anim) ctrl.store.setState({ activeFrame: anim.from });
      }
      renderAnimBar();
    },
  });

  const addAnimBtn = h('button', {
    type: 'button',
    title: 'Create named animation from frame range',
    onClick: () => {
      const s = ctrl.state;
      const n = s.doc.animations.length + 1;
      const from = 0;
      const to = Math.max(0, s.doc.frames.length - 1);
      ctrl.execute(addAnimationCommand(`Anim ${n}`, from, to, s.playDirection, s.playLoop));
      const created = ctrl.state.doc.animations[ctrl.state.doc.animations.length - 1];
      if (created) {
        ctrl.store.setState({ activeAnimationId: created.id });
        animEditorOpen = true;
      }
      renderAnimBar();
    },
  }, '+ Anim');

  const editAnimBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny',
    'aria-label': 'Edit named animation',
    title: 'Edit animation range / name',
    onClick: () => {
      animEditorOpen = !animEditorOpen;
      renderAnimBar();
    },
  }, icon('pencil', 14));

  const exportAnimBtn = h('button', {
    type: 'button',
    title: 'Open Export dialog for selected animation',
    onClick: () => {
      const scope = ctrl.state.activeAnimationId ?? 'all';
      onExportAnim?.(scope);
    },
  }, 'Export anim');

  const animBar = h('div', { class: 'anim-editor-bar', hidden: true });
  const renderAnimBar = () => {
    const s = ctrl.state;
    const activeAnim = s.activeAnimationId ? s.doc.animations.find((a) => a.id === s.activeAnimationId) ?? null : null;
    if (s.activeAnimationId && !activeAnim) {
      ctrl.store.setState({ activeAnimationId: null });
    }
    animSelect.replaceChildren(
      h('option', { value: '' }, `All frames (1–${s.doc.frames.length})`),
      ...s.doc.animations.map((a) =>
        h('option', { value: a.id, selected: a.id === activeAnim?.id }, `${a.name} (${a.from + 1}–${a.to + 1})`),
      ),
    );
    animSelect.value = activeAnim ? activeAnim.id : '';
    editAnimBtn.disabled = !activeAnim;

    const range = resolvePlaybackRange(s.doc, activeAnim?.id ?? null, s.playDirection, s.playLoop);
    dirSelect.value = range.direction;
    loopBtn.setAttribute('aria-pressed', String(range.loop));

    if (!activeAnim || !animEditorOpen) {
      animBar.hidden = true;
      return;
    }
    animBar.hidden = false;
    const maxF = s.doc.frames.length;
    const nameIn = h('input', {
      type: 'text', class: 'rename-input anim-name-in', value: activeAnim.name, 'aria-label': 'Animation name',
      onChange: () => {
        const name = nameIn.value.trim();
        if (name && name !== activeAnim.name) {
          ctrl.execute(updateAnimationCommand(activeAnim, { ...activeAnim, name }, 'Rename animation'));
        }
      },
    });
    const fromIn = h('input', {
      type: 'number', class: 'num tiny-num', min: 1, max: maxF, value: activeAnim.from + 1, 'aria-label': 'Start frame',
      onChange: () => {
        const from = Math.max(0, Math.min(maxF - 1, Math.round(Number(fromIn.value)) - 1));
        const to = Math.max(from, activeAnim.to);
        ctrl.execute(updateAnimationCommand(activeAnim, { ...activeAnim, from, to }, 'Animation range'));
      },
    });
    const toIn = h('input', {
      type: 'number', class: 'num tiny-num', min: 1, max: maxF, value: activeAnim.to + 1, 'aria-label': 'End frame',
      onChange: () => {
        const to = Math.max(0, Math.min(maxF - 1, Math.round(Number(toIn.value)) - 1));
        const from = Math.min(activeAnim.from, to);
        ctrl.execute(updateAnimationCommand(activeAnim, { ...activeAnim, from, to }, 'Animation range'));
      },
    });
    animBar.replaceChildren(
      h('span', { class: 'hint' }, 'Name'), nameIn,
      h('span', { class: 'hint' }, 'From'), fromIn,
      h('span', { class: 'hint' }, 'To'), toIn,
      h('button', {
        type: 'button',
        class: 'icon-btn tiny',
        'aria-label': 'Delete animation',
        title: 'Delete animation',
        onClick: () => {
          ctrl.execute(removeAnimationCommand(activeAnim.id));
          ctrl.store.setState({ activeAnimationId: null });
          animEditorOpen = false;
        },
      }, icon('trash', 14)),
    );
  };

  // ---- Layers x Frames Matrix ----
  const matrixWrap = h('div', { class: 'timeline-matrix-wrap' });
  const renderMatrix = () => {
    const s = ctrl.state;
    const { doc } = s;
    delFrameBtn.disabled = doc.frames.length <= 1;
    const activeRange = resolvePlaybackRange(doc, s.activeAnimationId, s.playDirection, s.playLoop);

    const headerCells = doc.frames.map((fr, fIdx) => {
      const inRange = s.activeAnimationId ? fIdx >= activeRange.from && fIdx <= activeRange.to : true;
      const durSpan = h('span', { class: 'frame-dur mono' }, `${fr.duration}ms`);
      const headBtn = h(
        'button',
        {
          type: 'button',
          class: `frame-head${inRange ? '' : ' out-range'}`,
          draggable: true,
          'aria-pressed': String(fIdx === s.activeFrame),
          title: `Frame ${fIdx + 1} (${fr.duration}ms) · Drag to reorder · Double-click to edit duration`,
          onClick: () => ctrl.store.setState({ activeFrame: fIdx }),
          onDblclick: () => {
            const inp = h('input', {
              type: 'number',
              class: 'num dur-edit',
              min: 16,
              max: 10000,
              value: fr.duration,
              'aria-label': `Frame ${fIdx + 1} duration ms`,
            });
            let done = false;
            const commit = () => {
              if (done) return;
              done = true;
              const v = Math.round(Number(inp.value));
              if (Number.isFinite(v) && v >= 16 && v !== fr.duration) {
                ctrl.execute(setFrameDurationCommand(fIdx, v));
              } else {
                renderMatrix();
              }
            };
            inp.addEventListener('blur', commit);
            inp.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') { done = true; renderMatrix(); }
            });
            durSpan.replaceWith(inp);
            inp.focus();
            inp.select();
          },
          onDragstart: () => { dragFrameFrom = fIdx; },
          onDragover: (e: DragEvent) => { e.preventDefault(); },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            if (dragFrameFrom >= 0 && dragFrameFrom !== fIdx) {
              ctrl.execute(reorderFrameCommand(dragFrameFrom, fIdx));
            }
            dragFrameFrom = -1;
          },
        },
        h('span', { class: 'mono' }, String(fIdx + 1)),
        durSpan,
      );
      return h('th', { scope: 'col' }, headBtn);
    });

    const layerRows = [...doc.layers].reverse().map((l) => {
      const cells = doc.frames.map((_, fIdx) => {
        const isCurrent = l.id === s.activeLayerId && fIdx === s.activeFrame;
        const isLooped = l.kind === 'pixel' && fIdx >= l.cels.length;
        const cel = l.kind === 'pixel' ? getLayerCel(l, fIdx) : undefined;
        const filled = Boolean(cel && celHasContent(cel));
        return h(
          'td',
          {},
          h(
            'button',
            {
              type: 'button',
              class: `cel-cell${filled ? ' has-px' : ''}${l.kind === 'reference' ? ' ref-cel' : ''}${isLooped ? ' loop-cel' : ''}`,
              'aria-current': isCurrent ? 'true' : 'false',
              'aria-label': `${l.name}, frame ${fIdx + 1}${isLooped ? ' (looped)' : ''}${filled ? ', has pixels' : ', blank'}`,
              title: isLooped ? `Looped from cel ${(fIdx % l.cels.length) + 1} of ${l.cels.length}` : undefined,
              onClick: () => ctrl.store.setState({ activeLayerId: l.id, activeFrame: fIdx }),
            },
            h('span', { class: 'cel-dot', 'aria-hidden': 'true' }),
          ),
        );
      });
      const celBadge =
        l.kind === 'pixel' && doc.frames.length > 1
          ? h(
              'span',
              { class: 'tl-cel-ctrl' },
              h('button', {
                type: 'button',
                class: 'tiny-btn tl-cel-step',
                'aria-label': `Decrease ${l.name} cel count`,
                title: 'Decrease layer cel count (independent loop)',
                disabled: l.cels.length <= 1,
                onClick: () => ctrl.execute(setLayerFrameCountCommand(l.id, l.cels.length - 1)),
              }, '-'),
              h('span', { class: 'mono tl-cel-count', title: `${l.cels.length} cels (${l.cels.length < doc.frames.length ? 'loops' : 'synced'})` }, `${l.cels.length}c`),
              h('button', {
                type: 'button',
                class: 'tiny-btn tl-cel-step',
                'aria-label': `Increase ${l.name} cel count`,
                title: 'Increase layer cel count',
                onClick: () => ctrl.execute(setLayerFrameCountCommand(l.id, l.cels.length + 1)),
              }, '+'),
            )
          : null;
      return h(
        'tr',
        { class: l.id === s.activeLayerId ? 'active-row' : '' },
        h('th', { scope: 'row', class: 'tl-layer-name' }, h('span', { class: 'tl-layer-title' }, l.name), celBadge),
        ...cells,
      );
    });

    const table = h(
      'table',
      { class: 'timeline-grid' },
      h('caption', { class: 'visually-hidden' }, 'Layers by frames timeline'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', class: 'tl-corner hint' }, 'Layer'), ...headerCells)),
      h('tbody', {}, ...layerRows),
    );

    matrixWrap.replaceChildren(table);
  };

  const timeToggleBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny',
    'aria-label': 'Toggle timeline',
    'aria-expanded': String(ctrl.state.timelineOpen),
    title: 'Collapse / expand timeline',
    onClick: () => ctrl.toggleTimeline(),
  }, icon(ctrl.state.timelineOpen ? 'chevDown' : 'chevRight', 14));

  const timelineEl = h(
    'section',
    { class: 'time', tabindex: -1, 'aria-label': 'Timeline' },
    h(
      'div',
      { class: 'bar' },
      timeToggleBtn,
      playBtn,
      dirSelect,
      loopBtn,
      h('span', { class: 'sep', role: 'separator', 'aria-orientation': 'vertical' }),
      h('button', {
        type: 'button',
        onClick: () => {
          ctrl.execute(addFrameCommand(ctrl.state.activeFrame, false));
          if (!ctrl.state.timelineOpen) ctrl.toggleTimeline();
        },
      }, '+ Blank'),
      h('button', {
        type: 'button',
        onClick: () => {
          ctrl.execute(addFrameCommand(ctrl.state.activeFrame, true));
          if (!ctrl.state.timelineOpen) ctrl.toggleTimeline();
        },
      }, '+ Copy'),
      delFrameBtn,
      h('label', { for: 'timeline-fps', class: 'hint' }, 'FPS'),
      fpsInput,
      h('span', { class: 'sep', role: 'separator', 'aria-orientation': 'vertical' }),
      onionToggleBtn,
      onionOptsBtn,
      h('span', { class: 'sep', role: 'separator', 'aria-orientation': 'vertical' }),
      animSelect,
      addAnimBtn,
      editAnimBtn,
      exportAnimBtn,
    ),
    onionBar,
    animBar,
    matrixWrap,
  );

  const closePopovers = (): boolean => {
    const hadOpen = onionSettingsOpen || animEditorOpen;
    if (!hadOpen) return false;
    const focusBack = onionSettingsOpen && onionBar.contains(document.activeElement)
      ? onionOptsBtn
      : animEditorOpen && animBar.contains(document.activeElement)
        ? editAnimBtn
        : null;
    onionSettingsOpen = false;
    animEditorOpen = false;
    onionOptsBtn.setAttribute('aria-expanded', 'false');
    renderOnionBar();
    renderAnimBar();
    focusBack?.focus();
    return true;
  };

  timelineEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closePopovers()) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  const syncOpen = () => {
    const open = ctrl.state.timelineOpen;
    timelineEl.classList.toggle('collapsed', !open);
    matrixWrap.hidden = !open;
    renderOnionBar();
    renderAnimBar();
    timeToggleBtn.setAttribute('aria-expanded', String(open));
    timeToggleBtn.replaceChildren(icon(open ? 'chevDown' : 'chevRight', 14));
  };

  renderMatrix();
  renderOnionBar();
  renderAnimBar();
  syncOpen();

  const u1 = ctrl.store.subscribe(
    (s) => [s.docRev, s.activeLayerId, s.activeFrame, s.activeAnimationId, s.playDirection, s.playLoop] as const,
    () => {
      renderMatrix();
      renderAnimBar();
    },
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );
  const u2 = ctrl.store.subscribe((s) => s.onion, renderOnionBar);
  const u3 = ctrl.store.subscribe((s) => s.timelineOpen, syncOpen);
  const u4 = ctrl.store.subscribe((s) => s.playing, (p) => {
    if (!p && playRaf) {
      window.cancelAnimationFrame(playRaf);
      playRaf = 0;
      syncPlayBtn(false);
    }
  });

  return {
    el: timelineEl,
    togglePlay,
    closePopovers,
    destroy() {
      stopPlayback();
      u1();
      u2();
      u3();
      u4();
    },
  };
}
