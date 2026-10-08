// Runs in the isolated world. No page scripts, form submission, or change events.
export function attachToInput(payload, index = 0) {
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  const input = inputs[index];
  if (!input || input.disabled || input.webkitdirectory) {
    throw new Error('This upload field is unavailable. Use the website’s file picker.');
  }
  const bytes = Uint8Array.from(atob(payload.base64), char => char.charCodeAt(0));
  const file = new File([bytes], payload.name, { type: payload.type, lastModified: payload.lastModified });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
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
