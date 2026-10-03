import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Set sha512 sync implementation (dibutuhkan @noble/ed25519)
ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array => {
  return sha512(ed.etc.concatBytes(...m));
};

export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string
): Promise<boolean> {
  try {
    const publicKey = hexToBytes(publicKeyHex);
    const signature = hexToBytes(signatureHex);
    const message = new TextEncoder().encode(timestamp + body);

    console.log(
      `[Discord] verify — pk:${publicKey.length} sig:${signature.length} msg:${message.length}`
    );

    const result = await ed.verifyAsync(signature, message, publicKey);

    console.log('[Discord] verify result:', result);
    return result;
  } catch (err) {
    console.error('[Discord] verify error:', err);
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}