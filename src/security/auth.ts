import fs from 'node:fs/promises';
import { AUTH_FILE, DATA_DIR, getCdpCandidates } from '../config.js';
import { CuaError } from '../errors.js';

export interface AuthRecord {
  authorized: boolean;
  grantedAt: string;
  source: string;
  note?: string;
}

export async function getAuthRecord(): Promise<AuthRecord | null> {
  try {
    const raw = await fs.readFile(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AuthRecord>;
    if (parsed.authorized === true && typeof parsed.grantedAt === 'string') {
      return {
        authorized: true,
        grantedAt: parsed.grantedAt,
        source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
        note: typeof parsed.note === 'string' ? parsed.note : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function isAuthorized(): Promise<boolean> {
  const record = await getAuthRecord();
  return record?.authorized === true;
}

export async function grantAuthorization(
  source = 'user-confirmed',
  note?: string,
): Promise<AuthRecord> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const record: AuthRecord = {
    authorized: true,
    grantedAt: new Date().toISOString(),
    source,
    note,
  };
  await fs.writeFile(AUTH_FILE, JSON.stringify(record, null, 2), 'utf8');
  return record;
}

export async function revokeAuthorization(): Promise<void> {
  try {
    await fs.unlink(AUTH_FILE);
  } catch {
    // Ignore when already absent.
  }
}

const ALLOWED_HTTP_SCHEMES = new Set(['http:', 'https:']);
const ALLOWED_CDP_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  '100.100.100.200',
  'fd00:ec2::254',
  '[fd00:ec2::254]',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

let blockedControlPort: number | null = null;

export function setBlockedControlPort(port: number | null): void {
  blockedControlPort = port && port > 0 ? port : null;
}

export function getBlockedRouteRegex(): RegExp {
  const metadataHosts = '169\\.254\\.169\\.254|metadata\\.google\\.internal|100\\.100\\.100\\.200|\\[fd00:ec2::254\\]';
  if (blockedControlPort !== null) {
    const loopbackPort = `(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${blockedControlPort}`;
    return new RegExp(
      `^https?:\\/\\/(?:(?:${metadataHosts})(?:[:\\/]|$)|${loopbackPort}(?:\\/|$))`,
      'i',
    );
  }
  return new RegExp(`^https?:\\/\\/(?:${metadataHosts})(?:[:\\/]|$)`, 'i');
}

export function isBlockedNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ERR_BLOCKED_BY_CLIENT|ERR_UNSAFE_REDIRECT/i.test(msg);
}

export function checkBlockedNavigationReason(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower === 'about:blank' ||
    lower === 'chrome://newtab' ||
    lower === 'chrome://newtab/' ||
    lower === 'edge://newtab' ||
    lower === 'edge://newtab/'
  ) {
    return null;
  }
  try {
    validateNavigationUrl(trimmed);
    return null;
  } catch (err) {
    if (err instanceof CuaError && err.code === 'SafetyBlocked') {
      return err.message;
    }
    return null;
  }
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

export function validateNavigationUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new CuaError('InvalidArgument', 'URL must not be empty');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CuaError('InvalidArgument', `Invalid URL: ${trimmed}`);
  }

  if (parsed.protocol === 'about:') {
    if (parsed.href.toLowerCase() !== 'about:blank') {
      throw new CuaError(
        'SafetyBlocked',
        `Blocked navigation to unsupported about URI "${parsed.href}"`,
        { url: trimmed },
      );
    }
    return 'about:blank';
  }

  if (!ALLOWED_HTTP_SCHEMES.has(parsed.protocol)) {
    throw new CuaError(
      'SafetyBlocked',
      `Blocked navigation to unsupported scheme "${parsed.protocol}"`,
      { url: trimmed },
    );
  }

  const host = normalizeHost(parsed.hostname);
  if (BLOCKED_METADATA_HOSTS.has(host) || BLOCKED_METADATA_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new CuaError(
      'SafetyBlocked',
      `Blocked navigation to restricted metadata host "${parsed.hostname}"`,
      { url: trimmed },
    );
  }

  if (
    blockedControlPort !== null &&
    LOOPBACK_HOSTS.has(host) &&
    Number(parsed.port) === blockedControlPort
  ) {
    throw new CuaError(
      'SafetyBlocked',
      `Blocked navigation to local control port ${blockedControlPort}`,
      { url: trimmed },
    );
  }

  return parsed.toString();
}

export function validateCdpEndpoint(rawEndpoint: string): string {
  const trimmed = rawEndpoint.trim();
  if (!trimmed) {
    throw new CuaError('InvalidArgument', 'CDP endpoint must not be empty');
  }
  if (trimmed === 'chrome') {
    return 'chrome';
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CuaError('InvalidArgument', `Invalid CDP endpoint URL: ${trimmed}`);
  }

  if (!ALLOWED_CDP_SCHEMES.has(parsed.protocol)) {
    throw new CuaError(
      'SafetyBlocked',
      `Blocked CDP connection using unsupported scheme "${parsed.protocol}"`,
      { endpoint: trimmed },
    );
  }

  const host = normalizeHost(parsed.hostname);
  const configured = getCdpCandidates().some((candidate) => {
    try {
      const c = new URL(candidate);
      return c.origin === parsed.origin;
    } catch {
      return false;
    }
  });

  if (!LOOPBACK_HOSTS.has(host) && !configured) {
    throw new CuaError(
      'SafetyBlocked',
      `Blocked non-loopback CDP endpoint "${parsed.hostname}" (only loopback or configured AGY_CHROME_CDP_URL endpoints are allowed)`,
      { endpoint: trimmed },
    );
  }

  return trimmed.replace(/\/+$/, '');
}

