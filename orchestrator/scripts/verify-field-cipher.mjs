// Proves io/fieldCipher.ts actually behaves like encryption, not just base64 obfuscation:
// round-trips correctly, produces different ciphertext each call (random IV), detects tampering
// (GCM auth tag), and fails closed on missing/malformed key config rather than silently no-op'ing.

import { randomBytes } from 'node:crypto';
import { createFieldCipher } from '../dist/io/fieldCipher.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const key = randomBytes(32).toString('base64');
const cipher = createFieldCipher({ BIGBRAIN_FIELD_ENCRYPTION_KEY: key });

const plaintext = 'I need to reorder chicken feed from the co-op before the end of the month.';
const ciphertext = cipher.encrypt(plaintext);

assert(ciphertext !== plaintext, 'ciphertext is not the plaintext itself');
assert(!ciphertext.includes('chicken'), 'ciphertext does not leak recognizable plaintext substrings');
assert(cipher.decrypt(ciphertext) === plaintext, 'decrypt(encrypt(x)) === x');

const ciphertext2 = cipher.encrypt(plaintext);
assert(ciphertext2 !== ciphertext, 'encrypting the same plaintext twice yields different ciphertext (random IV)');
assert(cipher.decrypt(ciphertext2) === plaintext, 'the second ciphertext also decrypts correctly');

// Tamper with one byte of the ciphertext payload (after the 12-byte IV + 16-byte auth tag prefix)
// and confirm GCM's authentication catches it rather than silently returning corrupted plaintext.
{
  const buf = Buffer.from(ciphertext, 'base64');
  buf[buf.length - 1] ^= 0xff;
  const tampered = buf.toString('base64');
  try {
    cipher.decrypt(tampered);
    assert(false, 'decrypting tampered ciphertext throws instead of returning corrupted data');
  } catch {
    assert(true, 'decrypting tampered ciphertext throws instead of returning corrupted data');
  }
}

// A different key must not be able to decrypt this ciphertext.
{
  const wrongCipher = createFieldCipher({ BIGBRAIN_FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  try {
    wrongCipher.decrypt(ciphertext);
    assert(false, 'a ciphertext cannot be decrypted with the wrong key');
  } catch {
    assert(true, 'a ciphertext cannot be decrypted with the wrong key');
  }
}

// Fail-closed config checks — a misconfigured deployment must refuse to start silently plaintext.
assert(
  (() => {
    try {
      createFieldCipher({});
      return false;
    } catch {
      return true;
    }
  })(),
  'missing BIGBRAIN_FIELD_ENCRYPTION_KEY throws rather than defaulting to no-op encryption',
);
assert(
  (() => {
    try {
      createFieldCipher({ BIGBRAIN_FIELD_ENCRYPTION_KEY: 'dG9vc2hvcnQ=' }); // decodes to 8 bytes, not 32
      return false;
    } catch {
      return true;
    }
  })(),
  'a key that does not decode to exactly 32 bytes throws rather than silently truncating/padding',
);

if (process.exitCode) {
  console.error('\nfield cipher verification FAILED');
  process.exit(1);
}
console.log('\nfield cipher verification passed');
