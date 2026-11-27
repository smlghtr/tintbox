export type Child = Node | string | number | null | false | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'style' || k === 'for' || k.startsWith('aria-') || k.startsWith('data-') || k === 'role' || k === 'focusgroup') {
      el.setAttribute(k, String(v));
    } else if (v === true && (k === 'disabled' || k === 'checked' || k === 'selected' || k === 'autofocus' || k === 'open')) {
      el.setAttribute(k, '');
      if (k in el) (el as unknown as Record<string, unknown>)[k] = true;
    } else if (k in el && k !== 'list') {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const kid of kids) {
    if (kid !== null && kid !== false && kid !== undefined) {
      el.append(typeof kid === 'number' ? String(kid) : kid);
    }
  }
  return el;
}

/** Roving tabindex fallback ONLY when native focusgroup is unsupported. */
export function wireToolbarFocusgroup(bar: HTMLElement): void {
  if ('focusGroup' in HTMLElement.prototype) return;

  const getItems = () =>
    Array.from(bar.querySelectorAll<HTMLElement>('button, input, select')).filter(
      (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
    );

  const init = () => {
    const items = getItems();
    items.forEach((b, i) => {
      b.tabIndex = i === 0 ? 0 : -1;
    });
  };
  init();

  bar.addEventListener('focusin', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const items = getItems();
    if (!items.includes(target)) return;
    items.forEach((b) => {
      b.tabIndex = b === target ? 0 : -1;
    });
  });

  bar.addEventListener('keydown', (e) => {
    const items = getItems();
    if (items.length === 0) return;
    const vertical = bar.getAttribute('aria-orientation') === 'vertical';
    const rtl = getComputedStyle(bar).direction === 'rtl';
    let delta = 0;
    if (vertical) {
      if (e.key === 'ArrowDown') delta = 1;
      else if (e.key === 'ArrowUp') delta = -1;
    } else {
      if (e.key === 'ArrowRight') delta = rtl ? -1 : 1;
      else if (e.key === 'ArrowLeft') delta = rtl ? 1 : -1;
    }
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (delta !== 0) {
      e.preventDefault();
      const next = items[(idx + delta + items.length) % items.length];
      next.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1].focus();
    }
  });
}

/** Slider paired with a numeric input supporting fractional steps, Arrow, Shift+Arrow (x10), and drag isolation. */
export function sliderField(opts: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  onInput: (v: number) => void;
  onCommit?: (v: number) => void;
}): { el: HTMLElement; setValue: (v: number) => void } {
  const step = opts.step ?? 1;
  const decimals = step < 1 ? Math.min(2, String(step).split('.')[1]?.length ?? 1) : 0;
  const quantize = (v: number) => {
    const clamped = Math.max(opts.min, Math.min(opts.max, v));
    if (decimals === 0) return Math.round(clamped);
    const factor = 10 ** decimals;
    return Math.round(clamped * factor) / factor;
  };

  const range = h('input', {
    id: `${opts.id}-range`,
    type: 'range',
    min: opts.min,
    max: opts.max,
    step,
    value: opts.value,
    draggable: false,
    'aria-label': opts.label,
  });

  const syncCssProgress = (v: number) => {
    range.style.setProperty('--attr-min', String(opts.min));
    range.style.setProperty('--attr-max', String(opts.max));
    range.style.setProperty('--control-value', String(v));
  };
  syncCssProgress(quantize(opts.value));

  // Prevent ancestor draggable cards/tabs or canvas pan handlers from hijacking range thumb dragging
  range.addEventListener('dragstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  range.addEventListener('pointerdown', (e) => e.stopPropagation());
  range.addEventListener('mousedown', (e) => e.stopPropagation());

  const num = h('input', {
    id: opts.id,
    class: 'num',
    type: 'number',
    min: opts.min,
    max: opts.max,
    step,
    value: opts.value,
    'aria-label': `${opts.label} value`,
  });

  let lastCommitted = quantize(opts.value);

  const emitInput = (raw: number) => {
    const v = quantize(raw);
    range.value = String(v);
    num.value = String(v);
    syncCssProgress(v);
    opts.onInput(v);
  };

  const emitCommit = () => {
    const v = quantize(Number(num.value));
    range.value = String(v);
    num.value = String(v);
    syncCssProgress(v);
    if (opts.onCommit && v !== lastCommitted) {
      lastCommitted = v;
      opts.onCommit(v);
    }
  };

  range.addEventListener('input', () => emitInput(Number(range.value)));
  range.addEventListener('change', emitCommit);

  num.addEventListener('input', () => {
    if (num.value !== '' && !Number.isNaN(Number(num.value))) emitInput(Number(num.value));
  });
  num.addEventListener('change', emitCommit);
  num.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey) {
      e.preventDefault();
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * 10;
      emitInput(Number(num.value) + delta);
      emitCommit();
    } else if (e.key === 'Enter') {
      emitCommit();
      num.blur();
    }
  });

  const el = h(
    'div',
    { class: 'row' },
    h('label', { for: opts.id }, opts.label),
    range,
    num,
  );

  return {
    el,
    setValue(v: number) {
      const c = quantize(v);
      lastCommitted = c;
      range.value = String(c);
      num.value = String(c);
      syncCssProgress(c);
    },
  };
}
