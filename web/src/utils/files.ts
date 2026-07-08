// Shared attachment helpers for the phone-side upload paths (Compose dispatches + card replies).
// Caps mirror the server: dispatch-store.ts (MAX_DISPATCH_ASSETS/DISPATCH_ASSET_MAX_BYTES) and
// cards-store.ts (MAX_RESPONSE_ASSETS/RESPONSE_ASSET_MAX_BYTES) both use 8 files / 10 MB each.
// Enforced client-side for immediate feedback; the server re-enforces regardless.
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// Read a File into base64 (no data: prefix) for an assets[].data field.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Convert the picked File[] into the wire shape the server expects on assets[].
export async function filesToAssets(files: File[]): Promise<{ filename: string; mime: string; data: string }[]> {
  return Promise.all(
    files.map(async (f) => ({
      filename: f.name,
      mime: f.type || 'application/octet-stream',
      data: await fileToBase64(f),
    })),
  );
}
