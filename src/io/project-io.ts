import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { ValidationError } from '../core/errors';
import { assembleDocFromManifest, buildProjectManifest, migrateProject } from '../core/project';
import type { Doc } from '../core/types';
import { MAX_IMPORT_BYTES } from './image';
import { bytesToDataUrl, decodePngRgba, encodePngRgba } from './png';

interface FilePickerHandle {
  createWritable(): Promise<{ write(data: Blob | Uint8Array): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<File>;
}

interface FsAccessWindow {
  showSaveFilePicker?: (opts: unknown) => Promise<FilePickerHandle>;
  showOpenFilePicker?: (opts: unknown) => Promise<FilePickerHandle[]>;
}

/** Pack a Doc into a versioned `.tintbox` zip archive (`project.json` + `cels/*.png` + `refs/*.png`). */
export function serializeTintboxArchive(doc: Doc): Uint8Array {
  const manifest = buildProjectManifest(doc);
  const files: Record<string, Uint8Array> = {
    'project.json': strToU8(JSON.stringify(manifest)),
  };

  for (const layer of doc.layers) {
    if (layer.kind === 'reference' && layer.ref) {
      files[`refs/${layer.id}.png`] = encodePngRgba(layer.ref.pixels, layer.ref.w, layer.ref.h);
    } else {
      layer.cels.forEach((cel, fIdx) => {
        files[`cels/${layer.id}_${fIdx}.png`] = encodePngRgba(cel, doc.w, doc.h);
      });
    }
  }
  for (const tile of doc.tileset.tiles) {
    files[`tiles/${tile.id}.png`] = encodePngRgba(tile.pixels, doc.tileset.tileW, doc.tileset.tileH);
  }

  return zipSync(files, { level: 6 });
}

/** Unpack, validate, migrate, and decode a `.tintbox` zip archive into a live Doc. */
export function deserializeTintboxArchive(bytes: Uint8Array): Doc {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new ValidationError(`Project file exceeds 50 MB limit.`);
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ValidationError('Could not read .tintbox archive (corrupt or not a zip file).');
  }

  const manifestBytes = entries['project.json'];
  if (!manifestBytes) throw new ValidationError('Missing project.json inside .tintbox archive.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new ValidationError('Corrupt project.json inside .tintbox archive.');
  }

  const manifest = migrateProject(parsed);
  const celPixels = new Map<string, Uint8ClampedArray>();
  const refImages = new Map<string, { pixels: Uint8ClampedArray; dataUrl: string }>();
  const tilePixels = new Map<string, Uint8ClampedArray>();

  for (const sl of manifest.layers) {
    if (sl.kind === 'reference' && sl.ref) {
      const pngBytes = entries[sl.ref.pngPath];
      if (!pngBytes) throw new ValidationError(`Missing reference image "${sl.ref.pngPath}".`);
      const decoded = decodePngRgba(pngBytes);
      refImages.set(sl.ref.pngPath, { pixels: decoded.data, dataUrl: bytesToDataUrl(pngBytes) });
    } else {
      for (const path of sl.celPaths) {
        const pngBytes = entries[path];
        if (!pngBytes) continue;
        const decoded = decodePngRgba(pngBytes);
        if (decoded.w !== manifest.w || decoded.h !== manifest.h) {
          throw new ValidationError(`Cel "${path}" is ${decoded.w}x${decoded.h}, expected ${manifest.w}x${manifest.h}.`);
        }
        celPixels.set(path, decoded.data);
      }
    }
  }

  for (const st of manifest.tileset.tiles) {
    const pngBytes = entries[st.pngPath];
    if (!pngBytes) continue;
    const decoded = decodePngRgba(pngBytes);
    if (decoded.w === manifest.tileset.tileW && decoded.h === manifest.tileset.tileH) {
      tilePixels.set(st.pngPath, decoded.data);
    }
  }

  return assembleDocFromManifest(manifest, celPixels, refImages, tilePixels);
}

/** Save `.tintbox` using File System Access API when available, else download fallback. */
export async function saveTintboxFile(doc: Doc, suggestedName = 'project.tintbox'): Promise<boolean> {
  const bytes = serializeTintboxArchive(doc);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: 'application/zip' });
  const win = typeof window !== 'undefined' ? (window as unknown as FsAccessWindow) : null;

  if (win?.showSaveFilePicker) {
    try {
      const handle = await win.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Tintbox project', accept: { 'application/zip': ['.tintbox'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      // Fall back to standard download on permission/sandbox refusal
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

/** Open `.tintbox` or `.psd` using File System Access API when available, else hidden file input fallback. */
export async function pickTintboxFile(): Promise<{ bytes: Uint8Array; name: string } | null> {
  const win = typeof window !== 'undefined' ? (window as unknown as FsAccessWindow) : null;
  if (win?.showOpenFilePicker) {
    try {
      const [handle] = await win.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: 'Tintbox, Aseprite, Photoshop, or GIF (.tintbox, .aseprite, .ase, .psd, .gif)',
            accept: {
              'application/zip': ['.tintbox'],
              'application/octet-stream': ['.aseprite', '.ase'],
              'image/vnd.adobe.photoshop': ['.psd'],
              'image/gif': ['.gif'],
            },
          },
        ],
      });
      const file = await handle.getFile();
      return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
    }
  }

  return new Promise<{ bytes: Uint8Array; name: string } | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tintbox,.aseprite,.ase,.psd,.gif,application/zip,image/vnd.adobe.photoshop,image/gif';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) {
        resolve(null);
        return;
      }
      resolve({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
