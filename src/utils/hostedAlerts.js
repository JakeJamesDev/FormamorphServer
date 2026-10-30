const db = require('../config/db');
const Message = require('../models/Message');
const { sendMail } = require('./mail');
const { staffAlertEmail } = require('../config/hostedAi');
const { SYSTEM_STATUS } = require('../config/accountDeletion');

/**
 * Tell the admins about a Formamorph AI event: an in-app message to each admin account, and a mail to the
 * staff address when the environment names one.
 *
 * Never throws: an alert rides on a request or a timer that must not fail because of it.
 *
 * @param {{ subject: string, body: string }} alert - What it says
 * @returns {Promise<void>} Resolves once the mail is sent or has failed
 */
const alertAdmins = async ({ subject, body }) => {
  try {
    const adminIds = db
      .prepare("SELECT id FROM users WHERE account_type = 'admin' AND status IS NOT ?")
      .all(SYSTEM_STATUS)
      .map((row) => row.id);
    Message.createForRecipients(adminIds, { senderId: null, senderAs: 'team', subject, body, severity: 'urgent' });
  } catch (error) {
    console.error('Hosted AI admin message failed:', error);
  }

  const to = staffAlertEmail();
  if (!to) return;
  try {
    await sendMail({ to, subject, text: body });
  } catch (error) {
    console.error('Hosted AI alert mail failed:', error);
  }
};

module.exports = { alertAdmins };
