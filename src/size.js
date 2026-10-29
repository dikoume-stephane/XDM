/**
 * Tailles lisibles en entrée (`500K`, `1,5 Mio`, `2g`) — lot `WP-37` (`D-067`).
 *
 * Les options qui prennent une taille (`--taille-max`, `--espace-min`) doivent accepter ce
 * qu'un humain écrit, pas seulement un nombre d'octets. Deux règles, pour que ce soit
 * prévisible :
 *
 *  1. **Unité binaire**, comme partout ailleurs dans XDM (`Kio`, `Mio` — `humanBytes`) :
 *     `K` vaut 1 024, jamais 1 000. Un plafond qui vaudrait 4,9 % de moins que ce que
 *     l'utilisateur croit lire serait un piège.
 *  2. **Refus explicite** plutôt que correction silencieuse : une unité inconnue, un nombre
 *     négatif ou un texte vide lèvent une erreur, ils ne valent pas « 0 » ni « illimité ».
 *
 * @module size
 */

/** Multiplicateurs acceptés, binaires. */
export const SIZE_UNITS = Object.freeze({
  '': 1,
  b: 1,
  o: 1,
  k: 1024,
  kib: 1024,
  kio: 1024,
  m: 1024 ** 2,
  mib: 1024 ** 2,
  mio: 1024 ** 2,
  g: 1024 ** 3,
  gib: 1024 ** 3,
  gio: 1024 ** 3,
  t: 1024 ** 4,
  tib: 1024 ** 4,
  tio: 1024 ** 4,
});

/**
 * Convertit une taille lisible en octets entiers.
 *
 * @param {string|number} input
 * @returns {number} octets (entier ≥ 0)
 * @throws {RangeError} si la valeur n'est pas une taille exploitable
 */
export function parseSize(input) {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 0) {
      throw new RangeError(`taille invalide : ${input}`);
    }
    return input;
  }
  if (typeof input !== 'string') throw new RangeError(`taille invalide : ${String(input)}`);
  // La virgule décimale française est acceptée : `1,5 Mio` est ce qu'on écrit ici.
  const cleaned = input.trim().replace(/\s+/g, '').replace(',', '.');
  if (cleaned === '') throw new RangeError('taille vide');
  const match = /^(\d+(?:\.\d+)?)([a-zio]*)$/i.exec(cleaned);
  if (!match) throw new RangeError(`taille invalide : ${input}`);
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = SIZE_UNITS[unit];
  if (multiplier === undefined) throw new RangeError(`unité inconnue : ${match[2]}`);
  const bytes = Math.round(value * multiplier);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError(`taille invalide : ${input}`);
  return bytes;
}
