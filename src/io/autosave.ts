const DB_NAME = 'tintbox-autosave';
const STORE_NAME = 'drafts';
const DRAFT_KEY = 'current';

export interface AutosaveDraft {
  bytes: Uint8Array;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveAutosaveDraft(bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const record: AutosaveDraft = { bytes: copy, savedAt: Date.now() };
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record, DRAFT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    } finally {
      db.close();
    }
  });
}

export async function loadAutosaveDraft(): Promise<AutosaveDraft | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(DRAFT_KEY);
      req.onsuccess = () => {
        const val = req.result as AutosaveDraft | undefined;
        if (val && val.bytes instanceof Uint8Array && val.bytes.byteLength > 0) {
          resolve(val);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function clearAutosaveDraft(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(DRAFT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    } finally {
      db.close();
    }
  });
}
