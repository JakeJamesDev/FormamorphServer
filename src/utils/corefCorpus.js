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

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const isLabelCorrection = (correction) => correction.kind === 'mention' || correction.kind === 'nonMention';

const SPEECH_VERB_RULES = ['after-subject-verb', 'after-verb-subject', 'before-verb'];
const SECOND_PERSON = /^(?:you|your|yours|yourself|yourselves)$/;
const FIRST_PERSON = /^(?:i|me|my|mine|myself)$/;
const POSSESSIVE = /['’]s$/;
const LEADING_ARTICLE = /^(?:a|an|the)\s+/i;

/** A mention's text as the client's player test reads it: lowercased, past a possessive and a leading article. */
const playerForm = (text) => text.replace(POSSESSIVE, '').toLowerCase().replace(LEADING_ARTICLE, '');

/** A test for "you", the narrator's "I" and the persona's names; a first-person word inside a quote is the speaker's. */
const playerWordTest = ({ passage, cast, quotes, playerId }) => {
  const names = playerNames(cast, playerId);
  const inQuote = (span) => quotes.some((quote) => span.start >= quote.start && span.end <= quote.end);
  return (span) => {
    const word = playerForm(passage.slice(span.start, span.end));
    return SECOND_PERSON.test(word) || names.has(word) || (FIRST_PERSON.test(word) && !inQuote(span));
  };
};

/** The persona's name, its words that no other cast name holds, and its aliases, as the client reads them. */
const playerNames = (cast, playerId) => {
  const persona = cast.find((record) => record.id === playerId);
  if (!persona) return new Set();
  const name = playerForm(persona.name.trim());
  const castWords = new Set(cast.filter((record) => record !== persona)
    .flatMap((record) => record.name.toLowerCase().split(/\s+/)));
  return new Set([name, ...name.split(/\s+/).filter((word) => !castWords.has(word)),
    ...persona.aliases.map((alias) => playerForm(alias.trim()))]);
};

/**
 * Mention labels made from quote corrections (Quote Speaker Data spec, Export). A player's overlapping fix drops one.
 *
 * @param {Object} row - A stored contribution, JSON already parsed
 * @returns {Array<{start: number, end: number, entityId: string}>} In quote order, one per span
 */
const deriveLabels = (row) => {
  const { cast, quotes, playerId, corrections } = row;
  if (!cast || !quotes) return [];

  const individual = (id) => id === playerId || cast.some((record) => record.id === id && record.kind === 'unique');
  const isPlayerWord = playerWordTest(row);

  const speakers = new Map();
  for (const { kind, start, end, entityId } of corrections) {
    if (kind === 'quote') speakers.set(`${start}:${end}`, entityId);
  }

  const labels = new Map();
  for (const quote of quotes) {
    const entityId = speakers.get(`${quote.start}:${quote.end}`);
    if (!entityId || !individual(entityId)) continue;

    const spans = [...quote.firstPerson];
    if (quote.mention && SPEECH_VERB_RULES.includes(quote.rule)
      && (entityId === playerId || !isPlayerWord(quote.mention))) {
      spans.unshift(quote.mention);
    }
    for (const span of spans) {
      labels.set(`${span.start}:${span.end}`, { start: span.start, end: span.end, entityId });
    }
  }

  const fixed = corrections.filter(isLabelCorrection);
  return [...labels.values()].filter((label) => !fixed.some((correction) => overlaps(label, correction)));
};

/**
 * The clusters after the derived labels, then the player's corrections (Character Mentions spec Q35, Q38).
 * A derived label names its whole unnamed cluster, unless that cluster mixes player words (Q67) or derived labels
 * claim it for more than one entity. Singletons drop.
 *
 * @param {Object} row - A stored contribution, JSON already parsed
 * @param {Array} derived - The row's derived labels, or none for the model's own clusters
 * @returns {{clusters: Array, named: Set}} The clusters, spans sorted, ordered by their first span; and the derived
 *   labels that named a whole cluster
 */
const labeledClusters = (row, derived) => {
  const isPlayerWord = derived.length ? playerWordTest(row) : null;
  const holds = (spans, span) => spans.some(([s, e]) => overlaps({ start: s, end: e }, span));
  // Both read the model's cluster, before any label moves a span out.
  const nameable = (spans) => {
    const player = spans.map(([start, end]) => isPlayerWord({ start, end }));
    const claimants = new Set(derived.filter((label) => holds(spans, label)).map((label) => label.entityId));
    return !(player.includes(true) && player.includes(false)) && claimants.size === 1;
  };
  let groups = row.clusters.map((spans, i) => ({
    entity: row.clusterEntities[i],
    spans: spans.map((s) => [...s]),
    nameable: isPlayerWord !== null && row.clusterEntities[i] === null && nameable(spans)
  }));
  const named = new Set();

  const join = (label, wholeCluster) => {
    const { start, end, entityId } = label;
    const unnamedHome = wholeCluster
      ? groups.find((group) => group.entity === null && group.nameable && holds(group.spans, label))
      : undefined;
    if (unnamedHome) named.add(label);

    for (const group of groups) {
      group.spans = group.spans.filter(([s, e]) => e <= start || s >= end);
    }
    if (entityId === null) return;

    const joined = groups.filter((group) => group.entity === entityId || group === unnamedHome);
    const merged = { entity: entityId, spans: [...joined.flatMap((group) => group.spans), [start, end]] };
    groups = [...groups.filter((group) => !joined.includes(group)), merged];
  };

  for (const label of derived) join(label, true);
  for (const correction of row.corrections.filter(isLabelCorrection)) {
    join({ ...correction, entityId: correction.kind === 'nonMention' ? null : correction.entityId }, false);
  }

  const byStart = (a, b) => a[0] - b[0] || a[1] - b[1];
  const clusters = groups
    .map((group) => group.spans.sort(byStart))
    .filter((spans) => spans.length > 1)
    .sort((a, b) => byStart(a[0], b[0]));
  return { clusters, named };
};

/**
 * What the export makes of a row: its clusters, its derived labels, and whether the clusters differ from the model's.
 *
 * @param {Object} row - A stored contribution, JSON already parsed
 * @returns {{clusters: Array, derivedLabels: Array, changesLabels: boolean}}
 */
const exportClusters = (row) => {
  const derived = deriveLabels(row);
  const { clusters, named } = labeledClusters(row, derived);
  const model = labeledClusters({ ...row, corrections: [] }, []).clusters;
  return {
    clusters,
    derivedLabels: derived.map((label) => ({ ...label, wholeCluster: named.has(label) })),
    changesLabels: JSON.stringify(clusters) !== JSON.stringify(model)
  };
};

/** A UTF-16 offset into `text` as a code-point offset, which is what the kit's Python reads. */
const codePointOffset = (text, offset) => Array.from(text.slice(0, offset)).length;

/**
 * One accepted contribution as an annotation-format line, or null when it changes no label.
 *
 * @param {Object} row - A stored contribution, JSON already parsed
 * @returns {Object|null} `{id, text, clusters}`
 */
const toAnnotation = (row) => {
  const { clusters, changesLabels } = exportClusters(row);
  if (!changesLabels) return null;
  return {
    id: `contribution-${row.id}`,
    text: row.passage,
    clusters: clusters.map((spans) => spans.map(([s, e]) => [codePointOffset(row.passage, s), codePointOffset(row.passage, e)]))
  };
};

module.exports = { PASSAGE_MAX, NAME_MAX, readSubmission, exportClusters, toAnnotation };
