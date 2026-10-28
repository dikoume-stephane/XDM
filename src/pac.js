/**
 * PAC (Proxy Auto-Config) — fiche C (`EX-C-09`, `WinHttpGetProxyForUrl`).
 *
 * IDM lit `%sproxy.pac` et délègue à Windows (`WinHttpGetProxyForUrl`) ; XDM n'a pas de
 * moteur JS à sa disposition pour exécuter un `FindProxyForURL` arbitraire. Ce module
 * implémente donc **un sous-ensemble explicite** du langage PAC, et refuse le reste :
 *
 *  - expressions : `&&`, `||`, `!`, parenthèses, `==`, `!=`, littéraux de chaîne,
 *    `true`/`false`, variables `host`, `url`, `dnsDomain`, et les fonctions `isPlainHostName`,
 *    `dnsDomainIs`, `localHostOrDomainIs`, `shExpMatch`, `dnsDomainLevels` ;
 *  - instructions : `if (...) return "…";`, `else`, blocs `{ }`, `return "…";` final ;
 *  - résultat : une chaîne `PROXY hôte:port; SOCKS5 hôte:port; DIRECT`, découpée en
 *    directives ordonnées, exactement comme un navigateur.
 *
 * Tout ce qui sort de ce sous-ensemble (`isResolvable`, `myIpAddress`, `new Date()`,
 * expressions régulières, appels de fonction utilisateur…) lève `PacError('UNSUPPORTED')`.
 * Deviner un PAC vaut moins qu'échouer bruyamment : une mauvaise route proxy est
 * indiscernable d'une panne réseau.
 *
 * @module pac
 */

/** Erreur PAC, porteuse d'un code stable. */
export class PacError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'PacError';
    this.code = code;
    this.details = details;
  }
}

/** Types de directives PAC reconnues. */
export const DIRECTIVE_TYPES = /** @type {const} */ (['PROXY', 'SOCKS', 'SOCKS5', 'SOCKS4', 'DIRECT']);

/**
 * Découpe la chaîne rendue par `FindProxyForURL` en directives ordonnées.
 *
 * @param {string} result
 * @returns {{type: 'PROXY' | 'SOCKS' | 'SOCKS4' | 'SOCKS5' | 'DIRECT',
 *   host: string | null, port: number | null}[]}
 */
export function parseProxyResult(result) {
  const directives = [];
  for (const raw of String(result).split(';')) {
    const item = raw.trim();
    if (item === '') continue;
    const [keyword, address] = item.split(/\s+/);
    const type = keyword.toUpperCase();
    if (type === 'DIRECT') {
      directives.push({ type: 'DIRECT', host: null, port: null });
      continue;
    }
    if (!DIRECTIVE_TYPES.includes(/** @type {any} */ (type))) {
      throw new PacError(`directive PAC inconnue : ${item}`, 'BAD_DIRECTIVE', { item });
    }
    if (!address) throw new PacError(`directive sans adresse : ${item}`, 'BAD_DIRECTIVE', { item });
    const separator = address.lastIndexOf(':');
    const host = separator < 0 ? address : address.slice(0, separator);
    const port = separator < 0 ? null : Number(address.slice(separator + 1));
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new PacError(`port invalide dans « ${item} »`, 'BAD_DIRECTIVE', { item });
    }
    directives.push({
      type: /** @type {any} */ (type),
      host,
      port: port ?? (type.startsWith('SOCKS') ? 1080 : 8080),
    });
  }
  if (directives.length === 0) throw new PacError('chaîne PAC vide', 'BAD_DIRECTIVE', { result });
  return directives;
}

/**
 * `dnsDomainIs(host, domaine)` — suffixe de domaine, casse ignorée.
 * @param {string} host
 * @param {string} domain
 * @returns {boolean}
 */
export const dnsDomainIs = (host, domain) => String(host).toLowerCase().endsWith(String(domain).toLowerCase());

/**
 * `shExpMatch(valeur, motif)` — `*` et `?` seulement, ancré des deux côtés.
 * @param {string} value
 * @param {string} pattern
 * @returns {boolean}
 */
export function shExpMatch(value, pattern) {
  const source = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i').test(String(value));
}

/** `isPlainHostName(host)` — pas de point dans le nom. */
export const isPlainHostName = (host) => !String(host).includes('.');

/** `dnsDomainLevels(host)` — nombre de points. */
export const dnsDomainLevels = (host) => (String(host).match(/\./g) ?? []).length;

/**
 * `localHostOrDomainIs(host, hôteComplet)`.
 * @param {string} host
 * @param {string} hostdom
 * @returns {boolean}
 */
export function localHostOrDomainIs(host, hostdom) {
  return host === hostdom || String(hostdom).toLowerCase().startsWith(`${String(host).toLowerCase()}.`);
}

/** Fonctions PAC autorisées, avec leur arité. */
const FUNCTIONS = new Map([
  ['isPlainHostName', 1],
  ['dnsDomainIs', 2],
  ['localHostOrDomainIs', 2],
  ['shExpMatch', 2],
  ['dnsDomainLevels', 1],
]);

/**
 * Découpe un script en jetons.
 * @param {string} source
 * @returns {{type: string, value: string}[]}
 */
function tokenize(source) {
  /** @type {{type: string, value: string}[]} */
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let cursor = index + 1;
      let value = '';
      while (cursor < source.length && source[cursor] !== quote) {
        if (source[cursor] === '\\') {
          cursor += 1;
          value += source[cursor] ?? '';
        } else {
          value += source[cursor];
        }
        cursor += 1;
      }
      tokens.push({ type: 'string', value });
      index = cursor + 1;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (['&&', '||', '==', '!=', '>=', '<='].includes(pair)) {
      tokens.push({ type: 'op', value: pair });
      index += 2;
      continue;
    }
    if ('!(),;{}<>'.includes(char)) {
      tokens.push({ type: 'punct', value: char });
      index += 1;
      continue;
    }
    const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
    if (identifier) {
      tokens.push({ type: 'word', value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    const number = /^\d+/.exec(source.slice(index));
    if (number) {
      tokens.push({ type: 'number', value: number[0] });
      index += number[0].length;
      continue;
    }
    throw new PacError(`caractère PAC non géré : « ${char} »`, 'UNSUPPORTED', { char });
  }
  return tokens;
}

/**
 * Extrait et compile le corps de `FindProxyForURL`.
 *
 * @param {string} script texte du `.pac`
 * @returns {{rules: {test: ((context: {url: string, host: string,
 *   dnsDomain: string}) => boolean) | null, result: string}[], fallback: string | null}}
 */
export function parsePac(script) {
  const text = String(script);
  const signature = /function\s+FindProxyForURL\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/.exec(text);
  if (!signature) {
    throw new PacError('FindProxyForURL(url, host) introuvable', 'NO_FUNCTION');
  }
  // Corps : de l'accolade ouvrante à l'accolade fermante correspondante.
  const start = signature.index + signature[0].length;
  let depth = 1;
  let cursor = start;
  while (cursor < text.length && depth > 0) {
    if (text[cursor] === '{') depth += 1;
    else if (text[cursor] === '}') depth -= 1;
    cursor += 1;
  }
  if (depth !== 0) throw new PacError('accolades déséquilibrées dans FindProxyForURL', 'BAD_SYNTAX');
  const body = text.slice(start, cursor - 1);

  const tokens = tokenize(body);
  let position = 0;

  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const expect = (value) => {
    const token = next();
    if (!token || token.value !== value) {
      throw new PacError(`PAC : « ${value} » attendu, « ${token?.value ?? 'fin'} » trouvé`, 'BAD_SYNTAX');
    }
    return token;
  };
  const isWord = (token, value) => token && token.type === 'word' && token.value === value;

  /** Analyse une expression booléenne et rend une fonction d'évaluation. */
  const parseOr = () => {
    let left = parseAnd();
    while (peek()?.value === '||') {
      next();
      const right = parseAnd();
      const leftFn = left;
      left = (context) => leftFn(context) || right(context);
    }
    return left;
  };
  const parseAnd = () => {
    let left = parseComparison();
    while (peek()?.value === '&&') {
      next();
      const right = parseComparison();
      const leftFn = left;
      left = (context) => leftFn(context) && right(context);
    }
    return left;
  };
  const parseComparison = () => {
    const left = parseUnary();
    const operator = peek();
    if (operator && (operator.type === 'op' || operator.type === 'punct')
      && ['==', '!=', '>=', '<=', '>', '<'].includes(operator.value)) {
      next();
      const right = parseUnary();
      const kind = operator.value;
      return (context) => {
        const a = left(context);
        const b = right(context);
        // Comparaison numérique dès que les deux côtés sont numériques (`dnsDomainLevels`).
        if (typeof a === 'number' && typeof b === 'number') {
          if (kind === '==') return a === b;
          if (kind === '!=') return a !== b;
          if (kind === '>') return a > b;
          if (kind === '<') return a < b;
          if (kind === '>=') return a >= b;
          return a <= b;
        }
        if (kind === '==') return String(a) === String(b);
        if (kind === '!=') return String(a) !== String(b);
        if (kind === '>') return String(a) > String(b);
        if (kind === '<') return String(a) < String(b);
        if (kind === '>=') return String(a) >= String(b);
        return String(a) <= String(b);
      };
    }
    return left;
  };
  const parseUnary = () => {
    const token = peek();
    if (token?.value === '!') {
      next();
      const inner = parseUnary();
      return (context) => !inner(context);
    }
    return parsePrimary();
  };
  const parsePrimary = () => {
    const token = next();
    if (!token) throw new PacError('PAC : expression incomplète', 'BAD_SYNTAX');
    if (token.value === '(') {
      const inner = parseOr();
      expect(')');
      return inner;
    }
    if (token.type === 'string') return () => token.value;
    if (token.type === 'number') return () => Number(token.value);
    if (token.type === 'word') {
      if (token.value === 'true') return () => true;
      if (token.value === 'false') return () => false;
      if (token.value === 'host') return (context) => context.host;
      if (token.value === 'url') return (context) => context.url;
      if (token.value === 'dnsDomain') return (context) => context.dnsDomain;
      if (FUNCTIONS.has(token.value)) {
        const arity = FUNCTIONS.get(token.value);
        expect('(');
        const args = [];
        for (let i = 0; i < arity; i += 1) {
          if (i > 0) expect(',');
          args.push(parseUnary());
        }
        expect(')');
        const name = token.value;
        return (context) => {
          const values = args.map((arg) => arg(context));
          switch (name) {
            case 'isPlainHostName': return isPlainHostName(values[0]);
            case 'dnsDomainIs': return dnsDomainIs(values[0], values[1]);
            case 'localHostOrDomainIs': return localHostOrDomainIs(values[0], values[1]);
            case 'shExpMatch': return shExpMatch(values[0], values[1]);
            case 'dnsDomainLevels': return dnsDomainLevels(values[0]);
            default: throw new PacError(`fonction PAC inconnue : ${name}`, 'UNSUPPORTED');
          }
        };
      }
      throw new PacError(`identifiant PAC non géré : ${token.value}`, 'UNSUPPORTED', { token: token.value });
    }
    throw new PacError(`jeton PAC inattendu : « ${token.value} »`, 'BAD_SYNTAX');
  };

  /** `return "…";` */
  const parseReturn = () => {
    expect('return');
    const token = next();
    if (!token || token.type !== 'string') {
      throw new PacError('PAC : `return` attend une chaîne littérale', 'UNSUPPORTED');
    }
    return token.value;
  };

  /**
   * Corps d'une branche : `return "…";` ou un bloc `{ … }`.
   * @returns {{result: string | null, rules: {test: Function, result: string}[]}}
   */
  const parseBranch = () => {
    if (peek()?.value === '{') {
      next();
      const rules = [];
      let result = null;
      while (peek() && peek().value !== '}') {
        if (isWord(peek(), 'if')) {
          const inner = parseConditional();
          rules.push(...inner.rules);
          continue;
        }
        if (isWord(peek(), 'return')) {
          result = parseReturn();
          expect(';');
          continue;
        }
        throw new PacError(`instruction PAC non gérée : « ${peek().value} »`, 'UNSUPPORTED', { token: peek().value });
      }
      expect('}');
      return { result, rules };
    }
    const result = parseReturn();
    expect(';');
    return { result, rules: [] };
  };

  /** `if (…) … else …` — les `else if` sont aplatis en conditions niées. */
  const parseConditional = () => {
    expect('if');
    expect('(');
    const test = parseOr();
    expect(')');
    const body = parseBranch();
    const rules = [];
    if (body.result !== null) rules.push({ test, result: body.result });
    rules.push(...body.rules);

    let fallback = null;
    if (isWord(peek(), 'else')) {
      next();
      if (isWord(peek(), 'if')) {
        const inner = parseConditional();
        for (const rule of inner.rules) {
          rules.push({ test: (context) => !test(context) && rule.test(context), result: rule.result });
        }
        fallback = inner.fallback;
      } else {
        const alternative = parseBranch();
        rules.push(...alternative.rules);
        fallback = alternative.result;
      }
    }
    return { rules, fallback };
  };

  /** Instructions de premier niveau. */
  const rules = [];
  let fallback = null;
  while (peek()) {
    if (isWord(peek(), 'if')) {
      const { rules: produced, fallback: rest } = parseConditional();
      rules.push(...produced);
      if (rest !== null) fallback = rest;
      continue;
    }
    if (isWord(peek(), 'return')) {
      fallback = parseReturn();
      expect(';');
      continue;
    }
    throw new PacError(`instruction PAC non gérée : « ${peek().value} »`, 'UNSUPPORTED', { token: peek().value });
  }

  return { rules, fallback };
}

/**
 * Résout le proxy d'une URL d'après un PAC analysé.
 *
 * @param {ReturnType<typeof parsePac>} pac
 * @param {string} url
 * @returns {{type: string, host: string | null, port: number | null}[]} directives ordonnées
 */
export function resolveProxy(pac, url) {
  const target = new URL(url);
  const host = target.hostname;
  const dot = host.indexOf('.');
  const context = { url, host, dnsDomain: dot < 0 ? host : host.slice(dot + 1) };
  for (const rule of pac.rules) {
    if (rule.test(context)) return parseProxyResult(rule.result);
  }
  if (pac.fallback !== null) return parseProxyResult(pac.fallback);
  return [{ type: 'DIRECT', host: null, port: null }];
}

/**
 * Fabrique un transport qui **résout le proxy à chaque URL**, comme le navigateur.
 *
 * Les directives sont essayées dans l'ordre rendu par le PAC (`PROXY a; PROXY b; DIRECT`) :
 * un proxy muet ne condamne pas la requête. `SOCKS` est traité comme `SOCKS5` — si le
 * proxy ne parle que SOCKS4, la connexion échoue explicitement (`PROXY_UNSUPPORTED`).
 *
 * @param {string} script texte du `.pac`
 * @param {{timeout?: number, directTransport?: Function}} [options]
 * @returns {(url: string, request?: {method?: string, headers?: Record<string, string>})
 *   => Promise<{status: number, headers: Record<string, string>,
 *   stream: import('node:stream').Readable}>}
 */
export function createPacTransport(script, { timeout, directTransport } = {}) {
  const resolve = createProxyResolver(script);
  return async function pacTransport(url, request = {}) {
    const directives = resolve(url);
    /** @type {unknown} */
    let lastError = null;
    for (const directive of directives) {
      if (directive.type === 'DIRECT') {
        if (directTransport) return directTransport(url, request);
        throw new PacError('PAC : aucune route directe disponible', 'NO_DIRECT_TRANSPORT');
      }
      const { createProxyTransport } = await import('./proxy.js');
      const { defaultTransport } = await import('./http-client.js');
      const type = directive.type === 'PROXY' ? 'http' : 'socks5';
      const transport = createProxyTransport(
        { type, host: directive.host, port: directive.port, auth: null },
        { ...(timeout ? { timeout } : {}) },
      );
      try {
        return await transport(url, request);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new PacError('PAC : aucune directive exploitable', 'NO_DIRECTIVE');
  };
}

/**
 * Compile un PAC en fonction `(url) => directives`.
 * @param {string} script
 * @returns {(url: string) => {type: string, host: string | null, port: number | null}[]}
 */
export function createProxyResolver(script) {
  const pac = parsePac(script);
  return (url) => resolveProxy(pac, url);
}
