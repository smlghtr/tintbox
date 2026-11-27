import {
  supportsBluetoothSerial,
  type PadClient,
  type PadClientStatus,
} from '../io/pad-client';
import type { AppController } from './controller';
import { h } from './dom';
import { icon } from './icons';

export interface PadDialogApi {
  el: HTMLDialogElement;
  open: () => void;
  updateStatus: (st: PadClientStatus) => void;
}

function openModal(dlg: HTMLDialogElement): void {
  if (typeof dlg.showModal === 'function') {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.setAttribute('open', '');
  }
}

function closeModal(dlg: HTMLDialogElement): void {
  if (typeof dlg.close === 'function') {
    if (dlg.open) dlg.close();
  } else {
    dlg.removeAttribute('open');
    dlg.dispatchEvent(new Event('close'));
  }
}

export function createPadDialog(ctrl: AppController, client: PadClient): PadDialogApi {
  const statusDot = h('span', { class: 'pad-dot' });
  const statusText = h('span', { class: 'mono' }, 'Disconnected');
  const errEl = h('p', { class: 'dlg-error' });

  const urlIn = h('input', {
    id: 'pad-ws-url',
    type: 'text',
    class: 'num pad-url-in',
    value: 'ws://127.0.0.1:8765',
    'aria-label': 'Pad bridge WebSocket URL',
  });

  const wsBtn = h('button', {
    type: 'button',
    class: 'primary',
    onClick: () => {
      if (client.status.status === 'connected' && client.status.transport === 'ws') {
        client.disconnect();
      } else {
        client.connectWebSocket(urlIn.value);
      }
    },
  }, 'Connect');

  const btSupported = supportsBluetoothSerial();
  const btBtn = h('button', {
    type: 'button',
    disabled: !btSupported,
    title: btSupported
      ? 'Connect directly to paired Android Bluetooth SPP serial port'
      : 'Requires Chromium (Chrome / Edge) Web Serial API',
    onClick: () => {
      if (client.status.status === 'connected' && client.status.transport === 'bt-serial') {
        client.disconnect();
      } else {
        // Close top-layer <dialog> first so Chromium's native Bluetooth Serial chooser is never blocked
        closeModal(dlg);
        void client.connectBluetoothSerial().then((ok) => {
          if (ok) ctrl.showToast('Bluetooth Pad connected', 'info');
          else if (client.status.error) ctrl.showToast(client.status.error, 'error');
        });
      }
    },
  }, 'Bluetooth Serial');

  const copyCmd = (cmd: string) => {
    void navigator.clipboard?.writeText(cmd).then(
      () => ctrl.showToast(`Copied: ${cmd}`, 'info'),
      () => ctrl.showToast(cmd, 'info'),
    );
  };

  const cmdLine = (label: string, cmd: string) =>
    h('div', { class: 'pad-cmd-row' },
      h('span', { class: 'hint' }, label),
      h('code', { class: 'pad-code mono' }, cmd),
      h('button', { type: 'button', class: 'tiny-btn', onClick: () => copyCmd(cmd) }, 'Copy'),
    );

  const dlg = h(
    'dialog',
    { class: 'modal modal-wide', 'aria-labelledby': 'dlg-pad-title' },
    h('div', { class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-pad-title' }, 'Android Drawing Pad (Tintbox Pad)'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close drawing pad dialog', onClick: () => closeModal(dlg) }, icon('x')),
      ),
      h('div', { class: 'modal-body' },
        h('div', { class: 'pad-status-row' }, statusDot, statusText),
        h('div', { class: 'row' },
          h('label', { for: 'pad-ws-url' }, 'Bridge'),
          urlIn,
          wsBtn,
          btBtn,
        ),
        errEl,
        h('div', { class: 'pad-guide' },
          h('h2', {}, '1. Start local relay (USB & Wi-Fi)'),
          cmdLine('Bridge', 'npm run pad-bridge'),
          h('h2', {}, '2. Connect Android (pick one)'),
          cmdLine('USB (~1ms)', 'adb reverse tcp:8765 tcp:8765'),
          h('p', { class: 'hint' }, 'USB: choose USB mode in Tintbox Pad (connects to 127.0.0.1:8765).'),
          h('p', { class: 'hint' }, 'Wi-Fi: same router, enter the LAN IP printed by pad-bridge into Tintbox Pad.'),
          h('p', { class: 'hint' }, 'Bluetooth: pair PC & phone, open Tintbox Pad → Setup → Bluetooth (Wait for PC), then click "Bluetooth Serial" above and pick your phone.'),
        ),
      ),
      h('footer', { class: 'modal-foot' },
        h('button', { type: 'button', class: 'primary', onClick: () => closeModal(dlg) }, 'Done'),
      ),
    ),
  );

  const updateStatus = (st: PadClientStatus) => {
    errEl.textContent = st.error ?? '';
    statusDot.classList.toggle('online', st.status === 'connected' && st.padsOnline > 0);
    statusDot.classList.toggle('waiting', st.status === 'connected' && st.padsOnline === 0);
    if (st.status === 'disconnected') {
      statusText.textContent = 'Disconnected';
      wsBtn.textContent = 'Connect';
      btBtn.textContent = 'Bluetooth Serial';
    } else if (st.status === 'connecting') {
      statusText.textContent = 'Connecting…';
      wsBtn.textContent = 'Cancel';
    } else if (st.transport === 'bt-serial') {
      statusText.textContent = 'Connected via Bluetooth Serial';
      btBtn.textContent = 'Disconnect BT';
      wsBtn.textContent = 'Connect';
    } else {
      const rtt = st.rttMs !== null ? ` · ${st.rttMs} ms` : '';
      statusText.textContent =
        st.padsOnline > 0
          ? `Pad online (${st.padsOnline})${rtt}`
          : 'Bridge connected · waiting for Android pad…';
      wsBtn.textContent = 'Disconnect';
    }
  };

  return {
    el: dlg,
    open() {
      updateStatus(client.status);
      openModal(dlg);
    },
    updateStatus,
  };
}
