/**
 * Contributed Character Mentions corrections: what a submit must hold, and how an accepted one becomes a
 * line of the training kit's annotation format (`{id, text, clusters}`, `[start, end)` code-point offsets).
 */

const PASSAGE_MAX = 16000;
const CLUSTERS_MAX = 500;
const MENTIONS_MAX = 4000;
const CORRECTIONS_MAX = 200;
const ID_MAX = 200;
const MODEL_ID_MAX = 64;
const NAME_MAX = 200;
const CORRECTION_KINDS = ['mention', 'quote', 'nonMention'];

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

/** Whether `offset` sits between two code points of `text`, never inside a surrogate pair. */
const onCodePoint = (text, offset) => offset === 0 || offset === text.length
  || !(isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset)));

const WORD_CHAR = /^[\p{L}\p{N}]$/u;

/** Whether `offset` splits a word: a letter or digit on both sides (spec Q39). */
const insideWord = (text, offset) => {
  if (offset === 0 || offset === text.length) return false;
  const before = Array.from(text.slice(Math.max(0, offset - 2), offset)).pop();
  const after = String.fromCodePoint(text.codePointAt(offset));
  return WORD_CHAR.test(before) && WORD_CHAR.test(after);
};

const validSpan = (text, start, end) => Number.isInteger(start) && Number.isInteger(end)
  && start >= 0 && end > start && end <= text.length && onCodePoint(text, start) && onCodePoint(text, end)
  && !insideWord(text, start) && !insideWord(text, end);

const boundedString = (value, max = ID_MAX) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/**
 * Keep the optional `{ entityId: name }` map to the entities the contribution references (spec Q71).
 *
 * @param {*} entityNames - The submitted map, or undefined/null when the client sent none
 * @param {Array<string|null>} referenced - Every entity id the clusters and corrections name
 * @returns {{error: string}|{value: Object}} The refusal, or the map without unreferenced keys
 */
const readEntityNames = (entityNames, referenced) => {
  if (entityNames === undefined || entityNames === null) return { value: {} };
  if (typeof entityNames !== 'object' || Array.isArray(entityNames)) return { error: 'Send entity names as a map' };

  const entries = [];
  for (const id of new Set(referenced)) {
    if (id === null || !Object.hasOwn(entityNames, id)) continue;
    if (!boundedString(entityNames[id], NAME_MAX)) return { error: 'An entity name is empty or too long' };
    entries.push([id, entityNames[id]]);
  }
  // fromEntries defines own keys, so an id such as "__proto__" keeps its name.
  return { value: Object.fromEntries(entries) };
};

const CAST_MAX = 200;
const ALIASES_MAX = 20;
const QUOTES_MAX = 500;
const FIRST_PERSON_MAX = 50;
const CLIENT_VERSION_MAX = 64;
const CAST_KINDS = ['unique', 'generic'];
// A newer client may send a rule this server does not know, so the rule is a shape, not a list.
const RULE_SHAPE = /^[a-z-]{1,40}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A `{start, end}` span of the passage, or null when it is not a valid one. */
const readSpan = (passage, value) => (isObject(value) && validSpan(passage, value.start, value.end)
  ? { start: value.start, end: value.end }
  : null);

/** The optional persona id: absent and null both read as no persona. */
const readPlayerId = (playerId) => {
  if (playerId === undefined || playerId === null) return { value: null };
  return boundedString(playerId) ? { value: playerId } : { error: 'playerId is empty or too long' };
};

/** The optional cast snapshot, one record per entity. */
const readCast = (cast) => {
  if (cast === undefined || cast === null) return { value: null };
  if (!Array.isArray(cast) || cast.length > CAST_MAX) return { error: `cast must be a list of at most ${CAST_MAX} records` };

  const records = [];
  for (const record of cast) {
    const { id, name, aliases, strangerName, kind } = isObject(record) ? record : {};
    if (!boundedString(id)) return { error: 'A cast record needs an id' };
    if (!boundedString(name, NAME_MAX)) return { error: 'A cast name is empty or too long' };
    if (!Array.isArray(aliases) || aliases.length > ALIASES_MAX
      || !aliases.every((alias) => boundedString(alias, NAME_MAX))) {
      return { error: `A cast record needs at most ${ALIASES_MAX} aliases, each non-empty and not too long` };
    }
    if (strangerName !== null && !boundedString(strangerName, NAME_MAX)) {
      return { error: 'A cast stranger name is empty or too long' };
    }
    if (kind !== null && !CAST_KINDS.includes(kind)) return { error: 'A cast kind is not known' };
    records.push({ id, name, aliases, strangerName, kind });
  }
  return { value: records };
};

/** The optional per-quote records: the shown speaker, the rule and its mentions. */
const readQuotes = (passage, quotes) => {
  if (quotes === undefined || quotes === null) return { value: null };
  if (!Array.isArray(quotes) || quotes.length > QUOTES_MAX) {
    return { error: `quotes must be a list of at most ${QUOTES_MAX} records` };
  }

  const records = [];
  for (const record of quotes) {
    const { speakerId, rule, mention, firstPerson } = isObject(record) ? record : {};
    const quote = readSpan(passage, record);
    if (!quote) return { error: 'A quote span falls outside the passage' };
    if (speakerId !== null && !boundedString(speakerId)) return { error: 'A quote speakerId is empty or too long' };
    if (typeof rule !== 'string' || !RULE_SHAPE.test(rule)) return { error: 'A quote rule is not a lowercase name' };

    const mentionSpan = mention === null ? null : readSpan(passage, mention);
    if (mention !== null && !mentionSpan) return { error: 'A quote mention span falls outside the passage' };

    if (!Array.isArray(firstPerson) || firstPerson.length > FIRST_PERSON_MAX) {
      return { error: `A quote needs a firstPerson list of at most ${FIRST_PERSON_MAX} spans` };
    }
    const firstPersonSpans = firstPerson.map((span) => readSpan(passage, span));
    if (firstPersonSpans.includes(null)) return { error: 'A quote firstPerson span falls outside the passage' };

    records.push({ ...quote, speakerId, rule, mention: mentionSpan, firstPerson: firstPersonSpans });
  }
  return { value: records };
};

const readVersions = ({ clientVersion, readingVersion }) => {
  if (clientVersion !== undefined && clientVersion !== null && !boundedString(clientVersion, CLIENT_VERSION_MAX)) {
    return { error: 'clientVersion is empty or too long' };
  }
  if (readingVersion !== undefined && readingVersion !== null && !(Number.isInteger(readingVersion) && readingVersion >= 1)) {
    return { error: 'readingVersion must be a positive whole number' };
  }
  return { value: { clientVersion: clientVersion ?? null, readingVersion: readingVersion ?? null } };
};

/**
 * Check a submitted contribution.
 *
 * @param {Object} body - The request body
 * @returns {{error: string}|{value: Object}} The refusal, or the normalized contribution
 */
const readSubmission = (body = {}) => {
  const { worldId, passage, modelId, modelVersion, clusters, clusterEntities, corrections, entityNames } = body;

  if (!boundedString(worldId)) return { error: 'Name the world' };
  if (typeof passage !== 'string' || passage.length === 0) return { error: 'Send the passage' };
  if (passage.length > PASSAGE_MAX) return { error: `A passage cannot exceed ${PASSAGE_MAX} characters` };
  if (!boundedString(modelId, MODEL_ID_MAX)) return { error: 'Name the model' };
  if (!Number.isInteger(modelVersion) || modelVersion < 1) return { error: 'Send the model version' };

  if (!Array.isArray(clusters) || clusters.length > CLUSTERS_MAX) return { error: 'Send the clusters' };
  let mentions = 0;
  for (const cluster of clusters) {
    if (!Array.isArray(cluster) || cluster.length === 0) return { error: 'A cluster is empty' };
    mentions += cluster.length;
    if (mentions > MENTIONS_MAX) return { error: 'Too many mentions' };
    for (const span of cluster) {
      if (!Array.isArray(span) || span.length !== 2 || !validSpan(passage, span[0], span[1])) {
        return { error: 'A cluster span falls outside the passage' };
      }
    }
  }

  if (!Array.isArray(clusterEntities) || clusterEntities.length !== clusters.length
    || !clusterEntities.every((entity) => entity === null || boundedString(entity))) {
    return { error: 'Send one entity or null per cluster' };
  }

  if (!Array.isArray(corrections) || corrections.length === 0) return { error: 'Send at least one correction' };
  if (corrections.length > CORRECTIONS_MAX) return { error: 'Too many corrections' };
  const normalized = [];
  for (const correction of corrections) {
    const { kind, start, end, entityId } = correction || {};
    if (!CORRECTION_KINDS.includes(kind)) return { error: 'Unknown correction kind' };
    if (!validSpan(passage, start, end)) return { error: 'A correction span falls outside the passage' };
    if (kind === 'nonMention' && entityId !== null) return { error: 'A non-mention names no entity' };
    if (entityId !== null && !boundedString(entityId)) return { error: 'A correction names no entity' };
    normalized.push({ kind, start, end, entityId });
  }

  const names = readEntityNames(entityNames, [...clusterEntities, ...normalized.map((c) => c.entityId)]);
  if (names.error) return names;

  const player = readPlayerId(body.playerId);
  if (player.error) return player;
  const cast = readCast(body.cast);
  if (cast.error) return cast;
  const quoteRecords = readQuotes(passage, body.quotes);
  if (quoteRecords.error) return quoteRecords;
  const versions = readVersions(body);
  if (versions.error) return versions;

  return {
    value: {
      worldId,
      passage,
      modelId,
      modelVersion,
      clusters: clusters.map((cluster) => cluster.map(([start, end]) => [start, end])),
      clusterEntities,
      corrections: normalized,
      entityNames: names.value,
      playerId: player.value,
      cast: cast.value,
      quotes: quoteRecords.value,
      ...versions.value
    }
  };
};

/**
 * The clusters after every mention correction: the span leaves its cluster, then joins the clusters named
 * its entity (merged when several) or starts a new one; a null entity or a nonMention leaves it out. Quote corrections are
 * skipped (Character Mentions spec Q36). Singletons drop.
 *
 * @param {Array} clusters - `[[[start, end], ...], ...]`
 * @param {Array} clusterEntities - The entity id or null per cluster
 * @param {Array} corrections - `{kind, start, end, entityId}`
 * @returns {Array} The corrected clusters, spans sorted, clusters ordered by their first span
 */
const applyCorrections = (clusters, clusterEntities, corrections) => {
  let groups = clusters.map((spans, i) => ({ entity: clusterEntities[i], spans: spans.map((s) => [...s]) }));

  for (const { kind, start, end, entityId } of corrections) {
    if (kind !== 'mention' && kind !== 'nonMention') continue;

    for (const group of groups) {
      group.spans = group.spans.filter(([s, e]) => e <= start || s >= end);
    }
    if (kind === 'nonMention' || entityId === null) continue;

    const named = groups.filter((group) => group.entity === entityId);
    const merged = { entity: entityId, spans: [...named.flatMap((group) => group.spans), [start, end]] };
    groups = [...groups.filter((group) => group.entity !== entityId), merged];
  }

  const byStart = (a, b) => a[0] - b[0] || a[1] - b[1];
  return groups
    .map((group) => group.spans.sort(byStart))
    .filter((spans) => spans.length > 1)
    .sort((a, b) => byStart(a[0], b[0]));
};

/** A UTF-16 offset into `text` as a code-point offset, which is what the kit's Python reads. */
const codePointOffset = (text, offset) => Array.from(text.slice(0, offset)).length;

/**
 * One accepted contribution as an annotation-format line.
 *
 * @param {Object} row - `{id, passage, clusters, clusterEntities, corrections}`, JSON already parsed
 * @returns {Object} `{id, text, clusters}`
 */
const toAnnotation = (row) => ({
  id: `contribution-${row.id}`,
  text: row.passage,
  clusters: applyCorrections(row.clusters, row.clusterEntities, row.corrections)
    .map((spans) => spans.map(([s, e]) => [codePointOffset(row.passage, s), codePointOffset(row.passage, e)]))
});

module.exports = { PASSAGE_MAX, NAME_MAX, readSubmission, toAnnotation };
