const CorefContribution = require('../models/CorefContribution');
const Policy = require('../models/Policy');
const { readSubmission, exportClusters, toAnnotation } = require('../utils/corefCorpus');

/** A queue row with what the export would make of it. */
const withLabels = (row) => {
  const { changesLabels, derivedLabels } = exportClusters(row);
  return { ...row, changesLabels, derivedLabels };
};
const changesNoLabel = (row) => !exportClusters(row).changesLabels;

/**
 * @desc    Contribute a passage's Character Mentions corrections
 * @route   POST /api/coref-contributions
 * @access  Private (age-attested accounts)
 */
exports.submit = async (req, res, next) => {
  try {
    if (!Policy.hasAccepted(Policy.AGE_GATE, req.user.id)) {
      return res.status(403).json({
        success: false,
        code: 'AGE_GATE_REQUIRED',
        error: 'Confirm you are 18 or older to contribute corrections.'
      });
    }

    const read = readSubmission(req.body);
    if (read.error) return res.status(400).json({ success: false, error: read.error });

    const { contribution, replaced } = CorefContribution.submit(req.user.id, read.value);
    res.status(replaced ? 200 : 201).json({
      success: true,
      data: { id: contribution.id, state: contribution.state, replaced }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Pending contributions, oldest first
 * @route   GET /api/coref-contributions
 * @access  Private (staff)
 */
exports.getQueue = async (req, res, next) => {
  try {
    // Clamped at both ends: SQLite reads a negative LIMIT as no limit.
    const asked = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 50;
    const data = CorefContribution.pending({ limit }).map(withLabels);
    res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    How many contributions wait for review, and how many of them change no label
 * @route   GET /api/coref-contributions/count
 * @access  Private (staff)
 */
exports.getCount = async (req, res, next) => {
  try {
    const noChange = CorefContribution.pendingAll().filter(changesNoLabel).length;
    res.status(200).json({ success: true, pending: CorefContribution.pendingCount(), noChange });
  } catch (error) {
    next(error);
  }
};

const review = (state) => async (req, res, next) => {
  try {
    const contribution = CorefContribution.review(req.params.id, state, req.user.id);
    if (!contribution) {
      return res.status(404).json({ success: false, error: 'No pending contribution with that id' });
    }
    res.status(200).json({ success: true, data: contribution });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/coref-contributions/:id/accept
 * @access  Private (staff)
 */
exports.accept = review('accepted');

/**
 * @route   POST /api/coref-contributions/:id/reject
 * @access  Private (staff)
 */
exports.reject = review('rejected');

/**
 * @desc    Reject every pending contribution that changes no label
 * @route   POST /api/coref-contributions/reject-no-change
 * @access  Private (staff)
 */
exports.rejectNoChange = async (req, res, next) => {
  try {
    const rejected = CorefContribution.rejectWhere(changesNoLabel, req.user.id);
    res.status(200).json({ success: true, rejected });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Accepted contributions that change a label, as annotation-format JSON Lines
 * @route   GET /api/coref-contributions/export
 * @access  Private (staff)
 */
exports.exportAccepted = async (req, res, next) => {
  try {
    const lines = CorefContribution.accepted().map(toAnnotation).filter(Boolean)
      .map((annotation) => `${JSON.stringify(annotation)}\n`);
    res.status(200)
      .type('application/x-ndjson')
      .set('Content-Disposition', 'attachment; filename="accepted.jsonl"')
      .send(lines.join(''));
  } catch (error) {
    next(error);
  }
};
