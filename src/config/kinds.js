/**
 * What a `worlds` row can hold. The table predates the others and keeps its name; `kind` is what
 * distinguishes them, so comments, downloads, tags, ownership, and search work the same for all three.
 */
const KINDS = ['world', 'entity', 'dictionary', 'model'];

/**
 * The kind assumed when a request doesn't name one.
 *
 * This is the compatibility contract with already-deployed clients: they were written when `worlds` held
 * only worlds and ask for `/api/worlds` with no `kind`. Defaulting to 'world' keeps their results exactly
 * as they were — a client that knows nothing about characters can never be handed one. Never widen this
 * default to "everything".
 */
const DEFAULT_KIND = 'world';

/**
 * Opt-in request for every kind at once, for a client that fetches the catalog in one go and splits it
 * itself. Safe precisely because it must be asked for by name: a client written before `kind` existed
 * sends nothing and still gets worlds only. This is a value for the *query*, never for a stored row.
 */
const ALL_KINDS = 'all';

/**
 * Valid on a list query: any real kind, or the explicit "everything". What may be *stored* on a row is a
 * narrower question, answered by `KINDS` alone — the create route validates against it, so `all` can be
 * asked for but never saved.
 */
const isValidKindQuery = (kind) => kind === ALL_KINDS || KINDS.includes(kind);

/**
 * What each kind must supply, and how big it may be.
 *
 * Worlds keep the original rules exactly. The other two are looser because their client-side shapes simply
 * don't have the fields: a dictionary has no image at all, and a character's portrait is optional, so
 * neither can promise a thumbnail. Nor do they carry a `description` — a character has player/AI
 * descriptions and a book has an optional note. The database columns stay NOT NULL; the controller fills
 * a placeholder thumbnail and an empty description, which satisfies them without a table rebuild.
 *
 * `maxContentBytes` is per kind because a lorebook has no business claiming the 200MB a world may need.
 */
const KIND_RULES = {
  world: {
    requiresDescription: true,
    requiresThumbnail: true,
    maxContentBytes: 200 * 1024 * 1024,
    label: 'World',
  },
  entity: {
    requiresDescription: false,
    requiresThumbnail: false,
    maxContentBytes: 25 * 1024 * 1024, // a portrait is base64 inside the content
    label: 'Character',
  },
  dictionary: {
    requiresDescription: false,
    requiresThumbnail: false,
    maxContentBytes: 5 * 1024 * 1024, // text entries only
    label: 'Dictionary',
  },
  model: {
    requiresDescription: false,
    requiresThumbnail: false,
    maxContentBytes: 64 * 1024 * 1024, // a VRM's mesh and textures, base64 inside the content
    label: 'Avatar',
  },
};

/** The rules for a kind, falling back to the default kind's for an unnamed one. */
const rulesFor = (kind) => KIND_RULES[kind] || KIND_RULES[DEFAULT_KIND];

/**
 * The Permissive License gate's failure identifiers, stable across releases.
 *
 * This is the contract with the client's copy of the same gate: each name is what a failed requirement is
 * reported as in a 400 body, and what the client's copy reports the same way from the file it read itself.
 * Renaming one silently breaks whichever side has not redeployed yet, so treat these as append-only.
 */
const MODEL_LICENSE_REQUIREMENTS = [
  'metaVersion',
  'avatarPermission',
  'allowRedistribution',
  'modification',
  'commercialUsage',
];

module.exports = {
  KINDS,
  DEFAULT_KIND,
  ALL_KINDS,
  isValidKindQuery,
  KIND_RULES,
  rulesFor,
  MODEL_LICENSE_REQUIREMENTS,
};
