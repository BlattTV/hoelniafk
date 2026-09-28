/**
 * Minecraft Java login from a Microsoft access token (scope XboxLive.signin) – the chain every
 * launcher uses:
 *
 *   Microsoft token ─▶ Xbox Live user token ─▶ XSTS (rp://api.minecraftservices.com/)
 *                   ─▶ Minecraft access token ─▶ profile (+ chat signing keys)
 *
 * Used with the ONE Microsoft sign-in of an identity (same grant as Outlook). Minecraft services only
 * accept Azure apps that Mojang approved for Minecraft login ("AppID review"); an unapproved app
 * gets 403 at login_with_xbox → MinecraftAppNotApprovedError, and the suite falls back to the
 * device-code sign-in.
 */
import type { JavaTokenResult } from './authService.js';

export interface XboxEndpoints {
  userAuth: string;
  xsts: string;
  minecraftLogin: string;
  minecraftProfile: string;
  minecraftCertificates: string;
}

export const XBOX_ENDPOINTS: XboxEndpoints = {
  userAuth: 'https://user.auth.xboxlive.com/user/authenticate',
  xsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  minecraftLogin: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  minecraftProfile: 'https://api.minecraftservices.com/minecraft/profile',
  minecraftCertificates: 'https://api.minecraftservices.com/player/certificates',
};

export class MinecraftAppNotApprovedError extends Error {
  constructor() {
    super('Your Azure app is not (yet) approved by Mojang for Minecraft login – using the Minecraft sign-in code instead');
  }
}

export type JsonHttp = (url: string, init: { method: 'GET' | 'POST'; body?: unknown; bearer?: string }) => Promise<{ status: number; json: any }>;

export const defaultJsonHttp: JsonHttp = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: {
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json', 'x-xbl-contract-version': '1' } : {}),
      ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

const XSTS_ERRORS: Record<string, string> = {
  '2148916233': 'This Microsoft account has no Xbox profile yet – sign in once on minecraft.net or xbox.com',
  '2148916235': 'Xbox Live is not available in the country of this account',
  '2148916236': 'This account needs adult verification (South Korea)',
  '2148916237': 'This account needs adult verification (South Korea)',
  '2148916238': 'This is a child account – it must be added to a Microsoft family by an adult first',
};

export async function minecraftFromMicrosoft(msAccessToken: string, http: JsonHttp = defaultJsonHttp, ep: XboxEndpoints = XBOX_ENDPOINTS): Promise<JavaTokenResult & { expiresAt: number }> {
  const user = await http(ep.userAuth, {
    method: 'POST',
    body: { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' },
  });
  if (user.status >= 400 || !user.json?.Token) throw new Error(`Xbox Live sign-in failed (${user.status})`);
  const uhs = user.json.DisplayClaims?.xui?.[0]?.uhs;

  const xsts = await http(ep.xsts, {
    method: 'POST',
    body: { Properties: { SandboxId: 'RETAIL', UserTokens: [user.json.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' },
  });
  if (xsts.status >= 400 || !xsts.json?.Token) {
    const code = String(xsts.json?.XErr ?? '');
    throw new Error(XSTS_ERRORS[code] ?? `Xbox authorization failed (${xsts.status}${code ? ` XErr ${code}` : ''})`);
  }

  const login = await http(ep.minecraftLogin, { method: 'POST', body: { identityToken: `XBL3.0 x=${uhs};${xsts.json.Token}` } });
  if (login.status === 403) throw new MinecraftAppNotApprovedError();
  if (login.status >= 400 || !login.json?.access_token) throw new Error(`Minecraft login failed (${login.status})`);
  const accessToken: string = login.json.access_token;

  const profile = await http(ep.minecraftProfile, { method: 'GET', bearer: accessToken });
  if (profile.status === 404 || !profile.json?.id) throw new Error('This Microsoft account does not own Minecraft Java Edition');
  if (profile.status >= 400) throw new Error(`Minecraft profile request failed (${profile.status})`);

  // Chat signing keys (optional – servers without secure chat work without them).
  let profileKeys: JavaTokenResult['profileKeys'] = null;
  const cert = await http(ep.minecraftCertificates, { method: 'POST', bearer: accessToken }).catch(() => null);
  if (cert && cert.status < 400 && cert.json?.keyPair) {
    profileKeys = {
      publicPEM: cert.json.keyPair.publicKey,
      privatePEM: cert.json.keyPair.privateKey,
      signature: cert.json.publicKeySignature,
      signatureV2: cert.json.publicKeySignatureV2,
      expiresOn: new Date(cert.json.expiresAt).toISOString(),
    };
  }
  return {
    profile: { id: profile.json.id, name: profile.json.name },
    accessToken,
    profileKeys,
    expiresAt: Date.now() + (Number(login.json.expires_in) || 86_400) * 1000,
  };
}
