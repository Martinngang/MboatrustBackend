const { Escrow, Project } = require('../models');
const catchAsync = require('../utils/catchAsync');

/**
 * Orange Money's Web Payment flow is redirect-based: after the payer
 * completes (or cancels) payment on Orange's page, Orange calls this
 * webhook (`notif_url`) server-to-server with the outcome. This is where a
 * 'pending' Escrow created in paymentService.collectOrangeMoney actually
 * resolves to 'completed' — there is no synchronous response for this
 * provider, unlike MTN MoMo's request-to-pay.
 */
const notify = catchAsync(async (req, res) => {
  const payload = { ...req.query, ...req.body };
  const reference = payload.pay_token || payload.notif_token || payload.token;
  const statusRaw = String(payload.status || '').toUpperCase();
  if (!reference) return res.status(400).json({ success: false, error: 'missing payment token' });

  const escrow = await Escrow.findOne({ paymentProvider: 'orange_money', providerReference: reference });
  if (!escrow) return res.status(404).json({ success: false, error: 'unknown transaction' });

  if (escrow.status === 'pending') {
    escrow.status = ['SUCCESS', 'SUCCESSFUL'].includes(statusRaw) ? 'completed' : statusRaw === 'FAILED' ? 'failed' : 'pending';
    await escrow.save();

    if (escrow.status === 'completed' && escrow.type === 'fund') {
      const project = await Project.findById(escrow.projectId);
      if (project && project.status === 'open') {
        project.status = 'funded';
        await project.save();
      }
    }
  }

  return res.status(200).json({ success: true });
});

/** Browser landing pages after the payer returns from Orange's payment page. */
const returnPage = (req, res) => res.status(200).json({ success: true, message: 'Payment completed — you may close this window.' });
const cancelPage = (req, res) => res.status(200).json({ success: true, message: 'Payment cancelled.' });

module.exports = { notify, returnPage, cancelPage };
