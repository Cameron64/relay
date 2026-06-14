import { notifications } from '@mantine/notifications';
import { sanitizeForClipboard } from './markdown';

function toast(message: string) {
  notifications.show({ message });
}

// Plain-text copy with a legacy execCommand fallback for non-secure contexts.
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed');
  }
}

// Copy rich HTML (+ plain fallback). Sanitized to a small semantic allowlist so it pastes cleanly
// into Teams/Slack/Outlook. Falls back to plain text if ClipboardItem is unavailable.
export async function copyRich(html: string, text: string): Promise<void> {
  const clean = sanitizeForClipboard(html);
  try {
    if (navigator.clipboard && 'ClipboardItem' in window && window.isSecureContext) {
      const item = new ClipboardItem({
        'text/html': new Blob([clean], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      toast('Copied formatted');
      return;
    }
  } catch {
    // fall through to plain
  }
  await copyText(text);
}

// Copy an attached image to the clipboard, normalized to PNG (the only format browsers reliably
// accept). Safari keeps the user gesture ONLY if the ClipboardItem value is a Promise of the blob.
export async function copyImage(assetUrl: string): Promise<void> {
  try {
    if (!(navigator.clipboard && 'ClipboardItem' in window && window.isSecureContext)) {
      throw new Error('no clipboard');
    }
    const pngPromise = (async (): Promise<Blob> => {
      const resp = await fetch(assetUrl, { credentials: 'include' });
      const blob = await resp.blob();
      if (blob.type === 'image/png') return blob;
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d')!.drawImage(bmp, 0, 0);
      return await new Promise<Blob>((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
      );
    })();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
    toast('Image copied');
  } catch {
    toast('Couldn’t copy image — long-press to copy');
  }
}
