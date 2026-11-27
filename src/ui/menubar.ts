import { h } from './dom';

export interface MenuItemSpec {
  label: string;
  shortcut?: string;
  checked?: () => boolean;
  disabled?: () => boolean;
  onSelect: () => void;
}

export interface MenuSeparatorSpec {
  separator: true;
}

export type MenuEntry = MenuItemSpec | MenuSeparatorSpec;

export interface TopMenuSpec {
  id: string;
  label: string;
  items: MenuEntry[];
}

function isSeparator(e: MenuEntry): e is MenuSeparatorSpec {
  return 'separator' in e;
}

function supportsPopover(): boolean {
  return typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;
}

function supportsAnchorPositioning(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('position-area: block-end');
}

/**
 * Photoshop-style Application Menu Bar implementing the WAI-ARIA Menubar + Popover API pattern:
 * - Single Tab stop with roving tabindex across top-level triggers
 * - ArrowLeft / ArrowRight switch between menus, ArrowDown enters open menu
 * - Hovering another trigger while any menu is open switches instantly
 * - Automatic viewport-aware positioning fallback when CSS anchor positioning is unavailable
 */
export function createAppMenubar(menus: TopMenuSpec[]): { el: HTMLElement; closeAll: () => void; destroy: () => void } {
  const bar = h('div', {
    class: 'app-menubar',
    role: 'menubar',
    'aria-label': 'Application menu',
  });

  const hasNativePopover = supportsPopover();
  const hasAnchor = supportsAnchorPositioning();
  const triggers: HTMLButtonElement[] = [];
  const popovers: HTMLElement[] = [];
  const menuGroups: HTMLElement[] = [];
  const syncers: (() => void)[] = [];
  let openIdx = -1;

  const isMenuOpen = (idx: number): boolean => {
    const p = popovers[idx];
    if (!p) return false;
    return hasNativePopover ? p.matches(':popover-open') : p.classList.contains('open');
  };

  const positionFallback = (idx: number) => {
    const trigger = triggers[idx];
    const pop = popovers[idx];
    if (!trigger || !pop) return;
    if (hasAnchor && hasNativePopover) return;
    const rect = trigger.getBoundingClientRect();
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const pw = Math.max(196, pop.offsetWidth || 210);
    const left = Math.max(4, Math.min(vw - pw - 4, rect.left));
    const top = Math.min(vh - 40, rect.bottom + 2);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  };

  const closeMenu = (idx: number) => {
    if (idx < 0 || idx >= popovers.length) return;
    const pop = popovers[idx];
    const trig = triggers[idx];
    if (hasNativePopover) {
      if (pop.matches(':popover-open')) {
        try {
          pop.hidePopover();
        } catch {
          // ignore already closed
        }
      }
    } else {
      pop.classList.remove('open');
      pop.hidden = true;
    }
    trig.setAttribute('aria-expanded', 'false');
    if (openIdx === idx) openIdx = -1;
  };

  const closeAll = () => {
    for (let i = 0; i < popovers.length; i++) closeMenu(i);
    openIdx = -1;
  };

  const openMenu = (idx: number, focusFirst = false) => {
    for (let i = 0; i < popovers.length; i++) {
      if (i !== idx) closeMenu(i);
    }
    syncers[idx]?.();
    const pop = popovers[idx];
    const trig = triggers[idx];
    if (hasNativePopover) {
      if (!pop.matches(':popover-open')) {
        try {
          (pop as HTMLElement & { showPopover(o?: { source?: HTMLElement }): void }).showPopover({ source: trig });
        } catch {
          pop.showPopover();
        }
      }
    } else {
      pop.hidden = false;
      pop.classList.add('open');
    }
    positionFallback(idx);
    trig.setAttribute('aria-expanded', 'true');
    openIdx = idx;
    if (focusFirst) {
      const first = menuGroups[idx]?.querySelector<HTMLButtonElement>('button:not([disabled])');
      first?.focus({ preventScroll: true });
    }
  };

  const moveRootTrigger = (fromIdx: number, dir: number, keepOpen: boolean) => {
    const nextIdx = (fromIdx + dir + triggers.length) % triggers.length;
    triggers.forEach((t, i) => {
      t.tabIndex = i === nextIdx ? 0 : -1;
    });
    if (keepOpen) openMenu(nextIdx, false);
    else closeAll();
    triggers[nextIdx].focus({ preventScroll: true });
  };

  menus.forEach((spec, idx) => {
    const trigId = `menu-trig-${spec.id}`;
    const popId = `menu-pop-${spec.id}`;
    const anchorName = `--menu-anchor-${spec.id}`;

    const trig = h('button', {
      id: trigId,
      type: 'button',
      class: 'menubar-trigger',
      role: 'menuitem',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      tabindex: idx === 0 ? 0 : -1,
      style: hasAnchor ? `anchor-name:${anchorName}` : '',
    }, spec.label);

    const itemButtons: { btn: HTMLButtonElement; checkEl: HTMLElement; spec: MenuItemSpec }[] = [];
    const listEl = h('div', {
      class: 'menu-list',
      role: 'menu',
      focusgroup: 'menu nomemory',
      'aria-labelledby': trigId,
    });

    for (const entry of spec.items) {
      if (isSeparator(entry)) {
        listEl.append(h('hr', { class: 'menu-sep' }));
        continue;
      }
      const checkEl = h('span', { class: 'menu-check mono', 'aria-hidden': 'true' }, '');
      const btn = h(
        'button',
        {
          type: 'button',
          class: 'menu-item',
          role: entry.checked ? 'menuitemcheckbox' : 'menuitem',
          onClick: () => {
            closeAll();
            entry.onSelect();
          },
        },
        checkEl,
        h('span', { class: 'menu-item-label' }, entry.label),
        entry.shortcut ? h('span', { class: 'menu-shortcut mono' }, entry.shortcut) : null,
      );
      itemButtons.push({ btn, checkEl, spec: entry });
      listEl.append(btn);
    }

    const syncItems = () => {
      for (const it of itemButtons) {
        const dis = it.spec.disabled ? it.spec.disabled() : false;
        it.btn.disabled = dis;
        if (it.spec.checked) {
          const chk = it.spec.checked();
          it.btn.setAttribute('aria-checked', String(chk));
          it.checkEl.textContent = chk ? '✓' : '';
        }
      }
    };

    const pop = h('div', {
      id: popId,
      class: 'menu-popover',
      ...(hasNativePopover ? { popover: 'auto' } : { hidden: true }),
      style: hasAnchor ? `position-anchor:${anchorName}` : '',
    }, listEl);

    if (hasNativePopover) {
      pop.addEventListener('toggle', (e) => {
        const te = e as Event & { newState?: string };
        const open = te.newState === 'open';
        trig.setAttribute('aria-expanded', String(open));
        if (open) {
          syncItems();
          positionFallback(idx);
          openIdx = idx;
        } else if (openIdx === idx) {
          openIdx = -1;
        }
      });
    }

    trig.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isMenuOpen(idx)) closeMenu(idx);
      else openMenu(idx, false);
    });

    trig.addEventListener('pointerenter', () => {
      if (openIdx >= 0 && openIdx !== idx) {
        triggers.forEach((t, i) => {
          t.tabIndex = i === idx ? 0 : -1;
        });
        openMenu(idx, false);
        trig.focus({ preventScroll: true });
      }
    });

    trig.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        moveRootTrigger(idx, 1, isMenuOpen(idx));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        moveRootTrigger(idx, -1, isMenuOpen(idx));
      } else if (e.key === 'ArrowDown' || e.key === 'Home') {
        e.preventDefault();
        openMenu(idx, true);
      } else if (e.key === 'End') {
        e.preventDefault();
        openMenu(idx, false);
        const enabled = Array.from(listEl.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
        enabled[enabled.length - 1]?.focus({ preventScroll: true });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeAll();
      }
    });

    listEl.addEventListener('keydown', (e) => {
      const enabled = Array.from(listEl.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
      const cur = enabled.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        enabled[(cur + 1 + enabled.length) % enabled.length]?.focus({ preventScroll: true });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        enabled[(cur - 1 + enabled.length) % enabled.length]?.focus({ preventScroll: true });
      } else if (e.key === 'Home') {
        e.preventDefault();
        enabled[0]?.focus({ preventScroll: true });
      } else if (e.key === 'End') {
        e.preventDefault();
        enabled[enabled.length - 1]?.focus({ preventScroll: true });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        moveRootTrigger(idx, 1, true);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        moveRootTrigger(idx, -1, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu(idx);
        trig.focus({ preventScroll: true });
      } else if (e.key === 'Tab') {
        closeAll();
      }
    });

    triggers.push(trig);
    popovers.push(pop);
    menuGroups.push(listEl);
    syncers.push(syncItems);
    bar.append(trig, pop);
  });

  const onDocClick = (e: MouseEvent) => {
    if (openIdx < 0) return;
    if (e.target instanceof Node && bar.contains(e.target)) return;
    closeAll();
  };
  document.addEventListener('click', onDocClick);

  return {
    el: bar,
    closeAll,
    destroy() {
      closeAll();
      document.removeEventListener('click', onDocClick);
    },
  };
}
