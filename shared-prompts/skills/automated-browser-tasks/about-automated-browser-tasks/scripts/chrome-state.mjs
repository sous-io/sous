/**
 * Chrome State Extraction
 *
 * Reads cookies from Chrome's SQLite DB, decrypts them using the OS keyring,
 * and produces Playwright-compatible storageState JSON.
 *
 * v10 format: 'v10'(3) + ciphertext. AES-128-CBC, IV = 16 spaces.
 * v11 format: 'v11'(3) + IV(16) + ciphertext. AES-128-CBC. Plaintext has 16-byte random prefix.
 * Key: PBKDF2(keyring_password, 'saltysalt', 1 iteration, 16 bytes, SHA1)
 */

import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { pbkdf2Sync, createDecipheriv } from 'crypto';
import Database from 'better-sqlite3';
import { getChromeSafeStoragePassword } from './keyring.mjs';

const DEFAULT_CHROME_BASE = join(homedir(), '.config', 'google-chrome');
const STATE_CACHE_DIR = join(homedir(), '.cache', 'browser-automation-state');

export function getChromeProfilePath(profileName = 'Default') {
  const profileDir = join(DEFAULT_CHROME_BASE, profileName);
  if (!existsSync(profileDir)) {
    throw new Error(
      `Chrome profile "${profileName}" not found at ${profileDir}. ` +
      `Available: ${listProfiles().join(', ')}`
    );
  }
  return profileDir;
}

export function listProfiles() {
  if (!existsSync(DEFAULT_CHROME_BASE)) return [];
  return readdirSync(DEFAULT_CHROME_BASE, { withFileTypes: true })
    .filter(d => d.isDirectory() && (d.name === 'Default' || d.name.startsWith('Profile ')))
    .map(d => d.name);
}

function deriveKey(password) {
  return pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
}

function decryptCookieValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length === 0) return '';

  const prefix = encryptedValue.slice(0, 3).toString('utf-8');

  if (prefix === 'v10') {
    const iv = Buffer.alloc(16, ' ');
    const ciphertext = encryptedValue.slice(3);
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return dec.toString('utf-8');
  }

  if (prefix === 'v11') {
    const iv = encryptedValue.slice(3, 19);
    const ciphertext = encryptedValue.slice(19);
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // v11 prepends 16 random bytes to the plaintext before encrypting
    return dec.slice(16).toString('utf-8');
  }

  // Unencrypted or unknown format
  return encryptedValue.toString('utf-8');
}

function chromeTimeToUnix(chromeTime) {
  if (!chromeTime || chromeTime === 0) return -1;
  const epochOffset = 11644473600000000n;
  const unixMicro = BigInt(chromeTime) - epochOffset;
  return Number(unixMicro / 1000000n);
}

/**
 * Read and decrypt cookies from a Chrome profile.
 * @param {string} profileName - Chrome profile name (default: 'Default')
 * @param {string[]|null} domains - Filter by domain substrings. Null = all cookies.
 */
export async function extractCookies(profileName = 'Default', domains = null) {
  const profileDir = getChromeProfilePath(profileName);
  const cookieDbPath = join(profileDir, 'Cookies');

  if (!existsSync(cookieDbPath)) {
    throw new Error(`Cookies database not found at ${cookieDbPath}`);
  }

  const password = await getChromeSafeStoragePassword();
  const key = deriveKey(password);

  const db = new Database(cookieDbPath, { readonly: true, fileMustExist: true });

  let query = 'SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies';
  const params = [];

  if (domains && domains.length > 0) {
    const clauses = domains.map(() => 'host_key LIKE ?');
    query += ` WHERE ${clauses.join(' OR ')}`;
    for (const d of domains) {
      params.push(`%${d}%`);
    }
  }

  const rows = db.prepare(query).all(...params);
  db.close();

  const cookies = [];
  for (const row of rows) {
    try {
      const value = decryptCookieValue(row.encrypted_value, key);
      cookies.push({
        name: row.name,
        value,
        domain: row.host_key,
        path: row.path,
        expires: chromeTimeToUnix(row.expires_utc),
        httpOnly: Boolean(row.is_httponly),
        secure: Boolean(row.is_secure),
        sameSite: ['None', 'Lax', 'Strict'][row.samesite] || 'None',
      });
    } catch (e) {
      // Skip cookies that fail to decrypt (shouldn't happen but don't break the whole run)
    }
  }

  return cookies;
}

/**
 * Build a Playwright-compatible storageState object.
 */
export async function buildStorageState(profileName = 'Default', domains = null) {
  const cookies = await extractCookies(profileName, domains);
  return { cookies, origins: [] };
}

/**
 * Write storageState to a JSON file and return the path.
 */
export async function saveStorageState(profileName = 'Default', domains = null) {
  mkdirSync(STATE_CACHE_DIR, { recursive: true });
  const state = await buildStorageState(profileName, domains);
  const outPath = join(STATE_CACHE_DIR, `storage-state-${profileName.replace(/\s+/g, '-')}.json`);
  writeFileSync(outPath, JSON.stringify(state, null, 2));
  return outPath;
}
