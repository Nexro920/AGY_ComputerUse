import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PLUGIN_ROOT =
  process.env.PLUGIN_ROOT?.trim() || path.resolve(__dirname, '..');

export const DATA_DIR =
  process.env.PLUGIN_DATA?.trim() ||
  path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'agy-chrome-use');

export const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
export const CONTROL_FILE = path.join(DATA_DIR, 'control.json');
export const CONTROL_DIR = path.join(DATA_DIR, 'controls');
export const CHROME_PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile');
export const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');

export function getCdpCandidates(): string[] {
  const raw = process.env.AGY_CHROME_CDP_URL?.trim();
  if (!raw) {
    return ['http://127.0.0.1:9222'];
  }
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}
