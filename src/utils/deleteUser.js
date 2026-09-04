const User = require('../models/User');
const { eraseUser } = require('./eraseUser');

/**
 * Erase an account from a shell, by name.
 *
 * A thin caller of the erasure module, which the deletion sweeper also calls: an account ends one way
 * whether a grace period ran out or an operator typed the name. Content goes by default; `--keep-content`
 * leaves the work behind the placeholder.
 *
 * @param {string} username - Username to erase
 * @param {Object} [options]
 *   `keepContent` — leave their listings and comments in place under the placeholder account
 * @returns {Promise<Object>} `{ success, message, deletedData }`, or `{ success, error }`
 */
async function deleteUser(username, { keepContent = false } = {}) {
  try {
    const user = User.findByUsername(username);

    if (!user) {
      return {
        success: false,
        error: `User '${username}' not found`
      };
    }

    const erased = await eraseUser(user, { removeContent: !keepContent });

    return {
      success: true,
      message: `Successfully deleted user '${username}' and all associated data`,
      deletedData: {
        user: erased.username,
        worlds: erased.worlds,
        comments: erased.comments,
        contentKept: keepContent
      }
    };
  } catch (error) {
    console.error('Error deleting user:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// If this script is run directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const keepContent = args.includes('--keep-content');
  const username = args.find((arg) => !arg.startsWith('--'));

  if (!username) {
    console.error('Usage: node deleteUser.js <username> [--keep-content]');
    process.exit(1);
  }

  deleteUser(username, { keepContent })
    .then(result => {
      if (result.success) {
        console.log('\n✅ SUCCESS:', result.message);
        if (result.deletedData) {
          console.log('Deleted data summary:');
          console.log(`  - User: ${result.deletedData.user}`);
          console.log(`  - Worlds: ${result.deletedData.worlds}${result.deletedData.contentKept ? ' (kept)' : ''}`);
          console.log(`  - Comments: ${result.deletedData.comments}${result.deletedData.contentKept ? ' (kept)' : ''}`);
        }
      } else {
        console.error('\n❌ ERROR:', result.error);
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('\n❌ FATAL ERROR:', error.message);
      process.exit(1);
    });
}

module.exports = deleteUser;
