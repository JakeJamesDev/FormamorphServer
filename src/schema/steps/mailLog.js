const { tableExists } = require('../columns');

/**
 * One row per mail SES accepted. Never an address: the row's id rides on the mail as a tag, so an SES event
 * finds its row without one.
 *
 * `user_id` is null for staff alert mail. `status` is `sent`, `delayed`, `delivered`, `bounced` or
 * `complained`; `bounce_type` is `hard` or `soft` on a bounced row and null otherwise.
 */
const apply = (database) => {
  if (tableExists(database, 'mail_log')) return false;

  database.exec(`
    CREATE TABLE mail_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      kind TEXT NOT NULL,
      message_id TEXT,
      status TEXT NOT NULL DEFAULT 'sent',
      bounce_type TEXT,
      sent_at TEXT NOT NULL,
      status_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
    CREATE INDEX idx_mail_log_sent_at ON mail_log(sent_at);
    CREATE INDEX idx_mail_log_user ON mail_log(user_id, sent_at);
  `);

  return true;
};

module.exports = { name: 'mailLog', apply };
