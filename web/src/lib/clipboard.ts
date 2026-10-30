/** Copies text for the patient; returns false if the browser refused (e.g. no recent user gesture). */
export async function copyText(text: string): Promise<boolean> {
  // 1. Try synchronous execCommand('copy') first while still inside the active user gesture
  // and before any window.open() or async call shifts document focus.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let syncCopied: boolean;
  try {
    syncCopied = document.execCommand('copy');
  } catch {
    syncCopied = false;
  } finally {
    area.remove();
  }
  if (syncCopied) return true;

  // 2. Fall back to the async Clipboard API.
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
