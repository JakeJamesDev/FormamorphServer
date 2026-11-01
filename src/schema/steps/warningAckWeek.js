const { tableExists, columnNames } = require('../columns');

/** Keys warning acknowledgments by week: databases built with a `month` column get it renamed. */
const apply = (database) => {
  if (!tableExists(database, 'hosted_warning_acks')) return false;
  const columns = columnNames(database, 'hosted_warning_acks');
  if (!columns.includes('month') || columns.includes('week')) return false;

  database.exec('ALTER TABLE hosted_warning_acks RENAME COLUMN month TO week');

  return true;
};

module.exports = { name: 'warningAckWeek', apply };
