/**
 * Politique de reprise face aux réponses transitoires (`WP-31`).
 *
 * Le client HTTP ne rejoue **jamais** une requête de lui-même : une nouvelle tentative est
 * une décision de la **file** (`attempts`, `D-036`), qui sait combien de fois elle a déjà
 * échoué et peut s'arrêter. Ce module fournit seulement les deux faits dont cette décision
 * a besoin : *ce statut vaut-il une nouvelle tentative ?* et *combien de temps le serveur
 * demande-t-il d'attendre ?*
 *
 * La distinction compte : un `404` rejoué dix fois reste un `404`, et une attente
 * silencieuse de 60 s dans le client ferait passer un serveur saturé pour un réseau lent.
 *
 * Aucune dépendance hors `node:`.
 *
 * @module retry
 */

/** Statuts qui peuvent disparaître d'eux-mêmes (charge, maintenance, quota). */
export const RETRYABLE_STATUSES = Object.freeze([429, 500, 502, 503, 504]);

/** Délai de repli quand le serveur ne dit rien, en millisecondes. */
export const DEFAULT_BACKOFF_MS = 500;

/** Plafond du délai calculé, en millisecondes (30 s). */
export const MAX_BACKOFF_MS = 30_000;

/** Plafond du `Retry-After` accepté, en millisecondes (une heure). */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/** Erreur de politique de reprise, porteuse d'un code stable. */
export class RetryError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'RetryError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Ce statut mérite-t-il une nouvelle tentative ?
 *
 * `408` (délai d'attente de la requête) est inclus : il est émis par les proxys surchargés
 * et ne dit rien du contenu. Les autres `4xx` sont des verdicts fermes.
 *
 * @param {number} status
 * @returns {boolean}
 */
export function isRetryableStatus(status) {
  return Number.isInteger(status) && (RETRYABLE_STATUSES.includes(status) || status === 408);
}

/**
 * Analyse un en-tête `Retry-After`.
 *
 * Le RFC 9110 autorise deux formes : un nombre de secondes (`120`) ou une date HTTP
 * (`Wed, 21 Oct 2015 07:28:00 GMT`). Les deux sont acceptées ; une valeur illisible rend
 * `null` — l'appelant applique alors son propre recul, plutôt qu'une attente inventée.
 *
 * @param {string | string[] | undefined | null} value
 * @param {number} [now] instant de référence (ms), injectable pour les tests
 * @returns {number | null} délai en millisecondes, jamais négatif
 */
export function parseRetryAfter(value, now = Date.now()) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  // Une date déjà passée vaut « tout de suite », jamais un délai négatif.
  return Math.max(0, Math.min(when - now, MAX_RETRY_AFTER_MS));
}

/**
 * Délai avant la `attempt`-ième nouvelle tentative (1 = la première).
 *
 * Recul exponentiel (`base · 2^(n-1)`) plafonné. **Pas d'aléa** : un test ne doit pas
 * dépendre du hasard, et un serveur unique n'a pas besoin de dispersion ; l'appelant peut
 * ajouter un jitter s'il lance beaucoup de connexions.
 *
 * @param {number} attempt
 * @param {{base?: number, max?: number}} [options]
 * @returns {number} millisecondes
 */
export function retryDelay(attempt, { base = DEFAULT_BACKOFF_MS, max = MAX_BACKOFF_MS } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RetryError('retryDelay : `attempt` doit être un entier ≥ 1', 'BAD_ATTEMPT', { attempt });
  }
  if (!(base > 0) || !(max > 0)) {
    throw new RetryError('retryDelay : `base` et `max` doivent être > 0', 'BAD_BACKOFF', { base, max });
  }
  const ceiling = Math.min(max, MAX_BACKOFF_MS);
  return Math.min(base * 2 ** (attempt - 1), ceiling);
}

/**
 * Faut-il rejouer, et après combien de temps ?
 *
 * Le `Retry-After` du serveur **prime** sur le recul calculé : c'est lui qui sait quand il
 * sera disponible. Sans en-tête, on applique `retryDelay`. Au-delà de `maxAttempts`, on
 * renonce (`retry: false`) et on explique pourquoi.
 *
 * `retryAfterMs` sert quand l'attente a **déjà** été extraite en amont (la sonde du client
 * HTTP la calcule et la transporte dans l'erreur) : sans ce paramètre, la file retomberait
 * sur un recul exponentiel alors que le serveur a dit combien de temps attendre — c'est
 * exactement le défaut que la porte G3 a mis au jour.
 *
 * @param {{status: number, headers?: Record<string, string|string[]|undefined>,
 *   retryAfterMs?: number|null, attempts: number, maxAttempts?: number, now?: number}} input
 * @returns {{retry: boolean, delayMs: number, reason: string}}
 */
export function planRetry({
  status, headers = {}, retryAfterMs = null, attempts, maxAttempts = 3, now = Date.now(),
}) {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new RetryError('planRetry : `attempts` doit être un entier ≥ 0', 'BAD_ATTEMPTS', { attempts });
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RetryError('planRetry : `maxAttempts` doit être un entier ≥ 1', 'BAD_MAX_ATTEMPTS', { maxAttempts });
  }
  if (!isRetryableStatus(status)) {
    return { retry: false, delayMs: 0, reason: `statut ${status} définitif` };
  }
  if (attempts >= maxAttempts) {
    return { retry: false, delayMs: 0, reason: `${attempts} tentative(s), plafond ${maxAttempts}` };
  }
  // L'attente déjà calculée prime : elle vient du même en-tête, mais d'un seul endroit.
  const announced = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? Math.min(/** @type {number} */ (retryAfterMs), MAX_RETRY_AFTER_MS)
    : parseRetryAfter(headers['retry-after'], now);
  if (announced !== null) {
    return { retry: true, delayMs: announced, reason: 'Retry-After du serveur' };
  }
  return { retry: true, delayMs: retryDelay(attempts + 1), reason: 'recul exponentiel' };
}
