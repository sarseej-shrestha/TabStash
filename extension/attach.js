// Runs in the isolated world. No page scripts, form submission, or change events.
export function inspectInputs() {
  const targets = new Map();
  const fields = [...document.querySelectorAll('input[type="file"]')]
    .filter(input => !input.disabled && !input.webkitdirectory && input.form)
    .map((input, index) => {
      const token = crypto.randomUUID();
      targets.set(token, input);
      return { token, label: input.labels?.[0]?.textContent?.trim().slice(0, 100) || input.getAttribute('aria-label') || input.name || `File field ${index + 1}`,
        accept: input.accept, occupied: input.files.length > 0 };
    });
  globalThis.__uploadSessionTargets = targets;
  return fields;
}

export function attachToInput(payload, token) {
  const input = globalThis.__uploadSessionTargets?.get(token);
  if (!input?.isConnected || input.type !== 'file' || !input.form || input.disabled || input.webkitdirectory) {
    throw new Error('This upload field is unavailable. Use the website’s file picker.');
  }
  if (input.files.length) throw new Error('The field already has a file. Clear it on the website before attaching.');
  const accepted = input.accept.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const name = payload.name.toLowerCase();
  const type = payload.type.toLowerCase();
  if (accepted.length && !accepted.some(rule => rule.startsWith('.') ? name.endsWith(rule) : rule.endsWith('/*') ? type.startsWith(rule.slice(0, -1)) : rule === type)) {
    throw new Error('This file does not match the field’s accepted file types. Use the website’s picker.');
  }
  const bytes = Uint8Array.from(atob(payload.base64), char => char.charCodeAt(0));
  const file = new File([bytes], payload.name, { type: payload.type, lastModified: payload.lastModified });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  globalThis.__uploadSessionTargets.delete(token);
  return { name: input.files[0]?.name, size: input.files[0]?.size };
}

export async function serializeFile(file) {
  const bytes = new Uint8Array(await file.blob.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32768) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  }
  return { name: file.name, type: file.blob.type, lastModified: file.lastModified, base64: btoa(binary) };
}
