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

    const key = await crypto.subtle.importKey(
      'raw',
      publicKey,
      { name: 'Ed25519' } as AlgorithmIdentifier,
      false,
      ['verify']
    );

    return await crypto.subtle.verify(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      key,
      signature,
      message
    );
  } catch (err) {
    console.error('[Discord] signature verify failed:', err);
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