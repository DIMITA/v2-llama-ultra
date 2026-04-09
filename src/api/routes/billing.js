'use strict';

const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const {
  isPricingEnabled,
  createCheckoutSession,
  createPortalSession,
  handleWebhook,
  PLANS,
} = require('../../pricing');

// ─── GET /billing/plans ───────────────────────────────────────────────────────

router.get('/plans', (_req, res) => {
  if (!isPricingEnabled()) {
    return res.json({ pricingEnabled: false, plan: PLANS.open });
  }
  const plans = Object.entries(PLANS)
    .filter(([id]) => id !== 'open')
    .map(([id, p]) => ({
      id,
      name:         p.name,
      description:  p.description,
      priceMonthly: p.priceMonthly,
      priceYearly:  p.priceYearly,
      limits:       p.limits,
    }));
  res.json({ pricingEnabled: true, plans });
});

// ─── POST /billing/checkout ───────────────────────────────────────────────────

router.post('/checkout', authMiddleware(), async (req, res) => {
  if (!isPricingEnabled()) {
    return res.status(400).json({ error: 'Pricing is disabled on this instance' });
  }
  const { planId, period = 'monthly' } = req.body;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  try {
    const session = await createCheckoutSession({
      planId,
      period,
      userId:     req.user.id,
      successUrl: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${baseUrl}/billing/cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /billing/portal ─────────────────────────────────────────────────────

router.post('/portal', authMiddleware(), async (req, res) => {
  if (!isPricingEnabled()) {
    return res.status(400).json({ error: 'Pricing is disabled on this instance' });
  }
  try {
    const session = await createPortalSession({
      customerId: req.user.stripeCustomerId,
      returnUrl:  `${req.protocol}://${req.get('host')}/billing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /billing/webhook (Stripe) ──────────────────────────────────────────

router.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!isPricingEnabled()) return res.json({ received: true });
    const sig = req.headers['stripe-signature'];
    try {
      const result = await handleWebhook(req.body, sig);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

module.exports = router;
