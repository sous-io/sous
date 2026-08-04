/**
 * Read Chrome's encryption password from the GNOME keyring via D-Bus Secret Service API.
 * Pure JS — no Python, no native dependencies beyond dbus-next.
 */

import dbus from 'dbus-next';

const SECRET_SERVICE_IFACE = 'org.freedesktop.Secret.Service';
const SECRET_SERVICE_PATH = '/org/freedesktop/secrets';
const SECRET_SERVICE_BUS = 'org.freedesktop.secrets';

/**
 * Reads the Chrome Safe Storage password from gnome-keyring.
 * Returns a Buffer containing the password bytes.
 */
export async function getChromeSafeStoragePassword() {
  const bus = dbus.sessionBus();

  try {
    const serviceProxy = await bus.getProxyObject(SECRET_SERVICE_BUS, SECRET_SERVICE_PATH);
    const service = serviceProxy.getInterface(SECRET_SERVICE_IFACE);

    // Open a plain-text session (no encryption over D-Bus — it's local)
    const sessionResult = await service.OpenSession('plain', new dbus.Variant('s', ''));
    const sessionPath = sessionResult[1];

    // Search for the Chrome Safe Storage item
    // SearchItems takes a{ss} — plain string dict, not Variants
    const searchResult = await service.SearchItems({
      'application': 'chrome',
      'xdg:schema': 'chrome_libsecret_os_crypt_password_v2',
    });

    const unlocked = searchResult[0];
    if (!unlocked || unlocked.length === 0) {
      throw new Error(
        'Chrome Safe Storage key not found in keyring. ' +
        'Make sure Chrome has been launched at least once and the keyring is unlocked.'
      );
    }

    const itemPath = unlocked[0];

    // Get the secret
    const secretsResult = await service.GetSecrets([itemPath], sessionPath);

    // secretsResult is a dict: {itemPath: (session_path, params_bytes, value_bytes, content_type)}
    const secret = secretsResult[itemPath];
    if (!secret) {
      throw new Error('Failed to retrieve secret from keyring');
    }

    // secret is [session_path, params_bytes, value_bytes, content_type_string]
    const valueBytes = secret[2];
    return Buffer.from(valueBytes);
  } finally {
    bus.disconnect();
  }
}
