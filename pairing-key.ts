function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pairingFingerprint(key: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("Invalid pairing key");
  const raw = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/") + "="), (value) => value.charCodeAt(0));
  if (raw.length !== 32 || base64url(raw) !== key) throw new Error("Invalid pairing key");
  const context = new TextEncoder().encode("bb-remote-login pairing root v1\0");
  const input = new Uint8Array(context.length + raw.length);
  input.set(context); input.set(raw, context.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function createPairingKey(): Promise<{ key: string; fingerprint: string }> {
  const key = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { key, fingerprint: await pairingFingerprint(key) };
}
