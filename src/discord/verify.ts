import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

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
    console.log(
      `[Discord] verify input — pk len:${publicKeyHex?.length ?? 0} ` +
        `sig len:${signatureHex?.length ?? 0} ts:${timestamp}`
    );

    // Validasi input
    if (!publicKeyHex || !signatureHex) {
      console.error('[Discord] publicKey or signature empty');
      return false;
    }

    if (!/^[0-9a-f]+$/i.test(publicKeyHex)) {
      console.error(
        '[Discord] public key bukan hex valid:',
        publicKeyHex.slice(0, 20)
      );
      return false;
    }

    if (!/^[0-9a-f]+$/i.test(signatureHex)) {
      console.error(
        '[Discord] signature bukan hex valid:',
        signatureHex.slice(0, 20)
      );
      return false;
    }

    const publicKey = hexToBytes(publicKeyHex);
    const signature = hexToBytes(signatureHex);
    const message = new TextEncoder().encode(timestamp + body);

    console.log(
      `[Discord] bytes — pk:${publicKey.length} sig:${signature.length} msg:${message.length}`
    );

    const result = await ed.verifyAsync(signature, message, publicKey);
    console.log('[Discord] verify result:', result);
    return result;
  } catch (err: any) {
    console.error(
      '[Discord] verify exception:',
      err?.message ?? String(err)
    );
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}