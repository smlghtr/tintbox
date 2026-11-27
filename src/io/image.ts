import { ValidationError } from '../core/errors';

export const MAX_IMPORT_DIM = 4096;
export const MAX_IMPORT_PIXELS = 64_000_000;
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const REF_SIZE_WARN_BYTES = 20 * 1024 * 1024;

export interface DecodedImage {
  w: number;
  h: number;
  pixels: Uint8ClampedArray;
  dataUrl: string;
}

export async function decodeImageBlob(blob: Blob): Promise<DecodedImage> {
  if (blob.size > MAX_IMPORT_BYTES) {
    const mb = (blob.size / (1024 * 1024)).toFixed(1);
    throw new ValidationError(`File is ${mb} MB. Max is 50 MB.`);
  }
  if (typeof createImageBitmap !== 'function') {
    throw new ValidationError('Browser does not support createImageBitmap.');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new ValidationError('Could not decode image file. Use PNG, JPEG, WebP, or GIF.');
  }

  try {
    const { width: w, height: h } = bitmap;
    if (w > MAX_IMPORT_DIM || h > MAX_IMPORT_DIM) {
      throw new ValidationError(`Image is ${w}x${h}. Max is ${MAX_IMPORT_DIM} per side.`);
    }
    if (w * h > MAX_IMPORT_PIXELS) {
      throw new ValidationError(`Image is ${(w * h / 1e6).toFixed(1)} MP. Max is 64 MP.`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new ValidationError('Could not create 2D canvas context.');
    ctx.drawImage(bitmap, 0, 0);
    const imgData = ctx.getImageData(0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/png');
    return { w, h, pixels: new Uint8ClampedArray(imgData.data), dataUrl };
  } finally {
    bitmap.close();
  }
}
