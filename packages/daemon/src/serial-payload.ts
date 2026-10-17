export type TxEncoding = 'ascii' | 'hex';

// Shared by the UI and daemon so validation matches the bytes actually sent.
export function parseSerialPayload(payload:string, encoding:TxEncoding, appendLF = false):Uint8Array {
  let bytes:Uint8Array;
  if (encoding === 'hex') {
    const text = payload.trim();
    if (!/^(?:[\da-f]{2}\s*)+$/i.test(text)) throw new Error('Enter complete HEX byte pairs, e.g. 01 03 00 FF or 010300FF.');
    const hex = text.replace(/\s/g,'');
    bytes = Uint8Array.from(hex.match(/.{2}/g)!,pair => parseInt(pair,16));
  } else {
    bytes = new TextEncoder().encode(payload);
  }
  if (!bytes.length || bytes.length + Number(appendLF) > 4096) throw new Error('Payload must be 1–4096 bytes, including appended LF.');
  if (!appendLF) return bytes;
  const result = new Uint8Array(bytes.length + 1);
  result.set(bytes); result[bytes.length] = 10;
  return result;
}
