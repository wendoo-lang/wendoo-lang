const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** `bytes` in unpadded base64url (RFC 4648, section 5). */
export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at] as number;
    const b = bytes[at + 1];
    const c = bytes[at + 2];
    text += alphabet[a >> 2];
    text += alphabet[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) text += alphabet[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) text += alphabet[c & 0x3f];
  }
  return text;
}
