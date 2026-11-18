/**
 * Print a vault key file to stdout.
 *   arc-vault-keygen                  new key file (version 1)
 *   arc-vault-keygen <existing-file>  add a new version for rotation (then run arc-vault-rewrap)
 */
import { generateKeyFile, loadKeyRing } from '../vault/vault.js';

const existing = process.argv[2];
process.stdout.write(generateKeyFile(existing ? loadKeyRing(existing) : undefined));
