import type { CheckStatus, HealthLevel, IdentityProfile, SessionInfo } from '../core/types.js';
import type { IdentityRepository } from './repository.js';
import type { NetworkConflict } from '../network/networkService.js';

export type HealthTarget = 'minecraft' | 'mail' | 'discord' | 'network' | 'sessions';

export interface HealthCheck {
  key: 'minecraftAuth' | 'mailAccess' | 'discordOAuth' | 'discordLinked' | 'networkProfile' | 'expectedIp' | 'sessions';
  label: string;
  status: CheckStatus;
  detail: string;
  /** Section of the identity view the UI navigates to when the check is clicked. */
  target: HealthTarget;
}

export interface HealthReport {
  identityId: number;
  level: HealthLevel;
  checks: HealthCheck[];
  /** First milestone: all six green. */
  milestone: Array<{ label: string; ok: boolean; target: HealthTarget }>;
  ready: boolean;
}

export function computeHealth(
  repo: IdentityRepository,
  identity: IdentityProfile,
  sessions: SessionInfo[],
  conflicts: NetworkConflict[],
): HealthReport {
  const id = identity.id;
  const s = identity.settings;
  const checks: HealthCheck[] = [];

  // Minecraft
  const mc = repo.getMinecraft(id);
  if (!mc) checks.push({ key: 'minecraftAuth', label: 'Minecraft auth', status: 'error', detail: 'No Minecraft account configured', target: 'minecraft' });
  else if (mc.authType === 'offline') checks.push({ key: 'minecraftAuth', label: 'Minecraft auth', status: 'ok', detail: 'Offline mode (test server)', target: 'minecraft' });
  else {
    const map: Record<string, CheckStatus> = { AUTHENTICATED: 'ok', PENDING: 'warn', NONE: 'warn', EXPIRED: 'error', ERROR: 'error' };
    checks.push({
      key: 'minecraftAuth',
      label: 'Minecraft auth',
      status: map[mc.authStatus] ?? 'unknown',
      detail: mc.authStatus === 'AUTHENTICATED' ? `${mc.username} (${mc.uuid ?? 'no uuid'})` : mc.lastError ?? mc.authStatus,
      target: 'minecraft',
    });
  }

  // Mail
  if (!s.mailEnabled) checks.push({ key: 'mailAccess', label: 'Mail access', status: 'skipped', detail: 'Mail disabled for this identity', target: 'mail' });
  else {
    const mail = repo.getMailIdentity(id);
    if (!mail && mc?.authType === 'microsoft' && mc.msaAccount) {
      // Outlook runs in the identity's Microsoft window (same login) – no mailbox to configure
      checks.push({ key: 'mailAccess', label: 'Mail access', status: 'ok', detail: `Outlook: ${mc.msaAccount}`, target: 'mail' });
    } else if (!mail) checks.push({ key: 'mailAccess', label: 'Mail access', status: mc?.authType === 'offline' ? 'skipped' : 'warn', detail: 'Sign in with Microsoft to use Outlook', target: 'mail' });
    else {
      const st: CheckStatus = mail.accessStatus === 'OK' ? 'ok' : mail.accessStatus === 'ERROR' ? 'error' : 'warn';
      checks.push({
        key: 'mailAccess',
        label: 'Mail access',
        status: st,
        detail: st === 'ok' ? `${mail.address} · ${mail.unreadCount} unread` : mail.lastError ?? `${mail.address} · not checked yet`,
        target: 'mail',
      });
    }
  }

  // Discord
  const d = repo.getDiscord(id);
  if (s.discordLinking === 'disabled') {
    checks.push({ key: 'discordOAuth', label: 'Discord', status: 'skipped', detail: 'Discord disabled', target: 'discord' });
    checks.push({ key: 'discordLinked', label: 'Discord linked', status: 'skipped', detail: 'Discord disabled', target: 'discord' });
  } else {
    const required = s.discordLinking === 'required';
    const oauth = d?.oauthState ?? 'NONE';
    const oauthStatus: CheckStatus = oauth === 'CONNECTED' ? 'ok' : oauth === 'PENDING' ? 'warn' : oauth === 'NONE' ? (required ? 'error' : 'warn') : 'error';
    checks.push({
      key: 'discordOAuth',
      label: 'Discord',
      status: oauthStatus,
      detail: oauth === 'CONNECTED' ? (d?.username ? `@${d.username}` : 'Set up') : d?.lastError ?? 'Not set up yet',
      target: 'discord',
    });
    const link = d?.linkState ?? 'UNKNOWN';
    // optional linking: not linked (yet) is fine – it only warns while a link is under way or failed
    const linkStatus: CheckStatus = link === 'LINKED' ? 'ok' : link === 'WAITING' ? 'warn' : link === 'ERROR' ? 'error' : required ? 'error' : 'skipped';
    checks.push({
      key: 'discordLinked',
      label: 'Discord linked',
      status: linkStatus,
      detail: link === 'LINKED' ? 'Linked on Minecraft server' : link === 'WAITING' ? 'Link code received – waiting for confirmation' : link === 'ERROR' ? d?.lastError ?? 'Link error' : required ? 'Not linked' : 'Not linked (optional)',
      target: 'discord',
    });
  }

  // Network
  const profile = identity.networkProfileId ? repo.getNetworkProfile(identity.networkProfileId) : null;
  if (s.networkMode === 'DIRECT') {
    checks.push({ key: 'networkProfile', label: 'Network profile', status: 'ok', detail: 'Direct connection (no dedicated exit)', target: 'network' });
  } else if (!profile) {
    // no own exit configured: the identity connects directly from this PC (or its agent)
    checks.push({ key: 'networkProfile', label: 'Network profile', status: 'ok', detail: 'Direct connection (no network profile)', target: 'network' });
  } else {
    const shared = conflicts.filter((c) => c.field !== 'expectedPublicIp' || s.networkMode === 'PER_ACCOUNT');
    checks.push({
      key: 'networkProfile',
      label: 'Network profile',
      status: shared.length && s.networkMode === 'PER_ACCOUNT' ? 'warn' : 'ok',
      detail: shared.length && s.networkMode === 'PER_ACCOUNT'
        ? `Shares ${shared[0].field} ${shared[0].value} with identity ${shared[0].otherIdentityId}`
        : `${profile.name} (${profile.kind}${profile.localBindIp ? ' ' + profile.localBindIp : ''})`,
      target: 'network',
    });
  }
  if (!profile) {
    checks.push({ key: 'expectedIp', label: 'Expected public IP', status: 'skipped', detail: 'Direct connection', target: 'network' });
  } else if (!profile.expectedPublicIp) {
    checks.push({
      key: 'expectedIp',
      label: 'Expected public IP',
      status: 'warn',
      detail: profile.actualPublicIp ? `No expected IP set (actual ${profile.actualPublicIp})` : 'No expected IP set',
      target: 'network',
    });
  } else {
    const map: Record<string, CheckStatus> = { OK: 'ok', MISMATCH: 'error', ERROR: 'error', UNKNOWN: 'warn' };
    checks.push({
      key: 'expectedIp',
      label: 'Expected public IP',
      status: map[profile.checkStatus],
      detail:
        profile.checkStatus === 'OK'
          ? `${profile.actualPublicIp} ✓`
          : profile.checkStatus === 'UNKNOWN'
            ? `Expected ${profile.expectedPublicIp} – not verified yet`
            : profile.lastError ?? profile.checkStatus,
      target: 'network',
    });
  }

  // Sessions: actual vs. desired state
  const assignments = repo.listAssignments(id).filter((a) => a.enabled);
  const desired = assignments.filter((a) => a.desiredState === 'ONLINE');
  // a session that is online counts, even if it was not set to "should be online" (e.g. started by hand)
  const onlineIds = new Set(sessions.filter((x) => x.state === 'ONLINE').map((x) => x.serverId));
  const wanted = assignments.filter((a) => a.desiredState === 'ONLINE' || onlineIds.has(a.serverId));
  const online = wanted.filter((a) => onlineIds.has(a.serverId)).length;
  const blocked = sessions.filter((x) => x.state === 'BLOCKED' && desired.some((a) => a.serverId === x.serverId));
  let sessionStatus: CheckStatus;
  let sessionDetail: string;
  if (assignments.length === 0) {
    sessionStatus = 'warn';
    sessionDetail = 'No server assignments';
  } else if (wanted.length === 0) {
    sessionStatus = 'warn';
    sessionDetail = `0 of ${assignments.length} assignment(s) set to online`;
  } else {
    sessionStatus = blocked.length ? 'error' : online === wanted.length ? 'ok' : 'warn';
    sessionDetail = `${online}/${wanted.length} online` + (blocked.length ? ` · ${blocked.length} blocked (${blocked[0].lastError ?? 'see session'})` : '');
  }
  checks.push({ key: 'sessions', label: 'Minecraft sessions', status: sessionStatus, detail: sessionDetail, target: 'sessions' });

  const statuses = checks.map((c) => c.status);
  const level: HealthLevel = statuses.includes('error') ? 'ERROR' : statuses.some((x) => x === 'warn' || x === 'unknown') ? 'WARNING' : 'HEALTHY';

  const ok = (k: HealthCheck['key']) => {
    const c = checks.find((x) => x.key === k)!;
    return c.status === 'ok' || c.status === 'skipped';
  };
  const milestone = [
    { label: 'Minecraft', ok: ok('minecraftAuth'), target: 'minecraft' as const },
    { label: 'Mail', ok: ok('mailAccess'), target: 'mail' as const },
    { label: 'Discord', ok: ok('discordOAuth'), target: 'discord' as const },
    { label: 'Discord Link', ok: ok('discordLinked'), target: 'discord' as const },
    { label: 'Exit IP', ok: ok('networkProfile') && ok('expectedIp'), target: 'network' as const },
    { label: 'Session', ok: ok('sessions'), target: 'sessions' as const },
  ];
  return { identityId: id, level, checks, milestone, ready: milestone.every((m) => m.ok) };
}
