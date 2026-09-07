/**
 * The fixed policy identifiers this server hosts, named apart from the model that reads them.
 *
 * The schema step that seeds the Privacy Policy needs the id and the title, and a migration must not have
 * to open the model — and through it a second database connection — to learn them.
 */

/** The blocking gate shown before a user may publish anything. */
const UPLOAD_GATE = 'upload_gate';

/** The advisory notice shown whenever a publish carries one of its tags. */
const TAG_NOTICE = 'tag_notice';

/** What the server stores about an account. Refuses every authenticated route until it is accepted. */
const PRIVACY_POLICY = 'privacy_policy';

/** The fixed adult-content attestation shared by the site and game. */
const AGE_GATE = 'age_gate';

/** The heading the seeded row ships with; the owner may rename it from the Policies tab. */
const PRIVACY_TITLE = 'Privacy Policy';

/**
 * How long each body may be. The popups mirror the message composer's cap; the Privacy Policy is a legal
 * document the server seeds at over six thousand characters, so it gets its own.
 */
const BODY_MAX = {
  [UPLOAD_GATE]: 4000,
  [TAG_NOTICE]: 4000,
  [PRIVACY_POLICY]: 20000
};

/** Every policy an admin may author. */
const POLICY_IDS = [UPLOAD_GATE, TAG_NOTICE, PRIVACY_POLICY];

/**
 * The policies a user answers, as opposed to the tag notice, which only tells a client what to show.
 * Answering is what gives these an acceptance version and a re-accept control.
 */
const ANSWERED_POLICY_IDS = [UPLOAD_GATE, PRIVACY_POLICY];

module.exports = {
  UPLOAD_GATE,
  TAG_NOTICE,
  PRIVACY_POLICY,
  AGE_GATE,
  PRIVACY_TITLE,
  BODY_MAX,
  POLICY_IDS,
  ANSWERED_POLICY_IDS
};
