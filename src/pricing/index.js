'use strict';

/**
 * pricing/index.js
 * Pricing guard & Stripe integration.
 *
 * KILL SWITCH: set PRICING_ENABLED=false (env) or pricingEnabled=false (config)
 * to run in fully open / self-hosted mode with no limits.
 */

const { PLANS } = require('./plans');

// ─── Is pricing active? ───────────────────────────────────────────────────────

function isPricingEnabled() {
  const env = process.env.PRICING_ENABLED;
  if (env !== undefined) return env !== 'false' && env !== '0';
  // Fall through to config
  try {
    const { loadConfig } = require('../config/loader');
    return loadConfig().pricingEnabled !== false;
  } catch {
    return true;
  }
}

// ─── Get effective plan ───────────────────────────────────────────────────────

function getEffectivePlan(planId) {
  if (!isPricingEnabled()) return PLANS.open;
  return PLANS[planId] ?? PLANS.free;
}

// ─── Limit guard ─────────────────────────────────────────────────────────────

function checkLimit(user, capability, value = 1) {
  const plan = getEffectivePlan(user?.planId ?? 'free');

  if (capability === 'quantization') {
    if (!plan.limits.quantizations.includes(value)) {
      return {
        allowed: false,
        reason:  `Quantization '${value}' not available on ${plan.name} plan. Upgrade to Pro or higher.`,
        upgrade: 'pro',
      };
    }
    return { allowed: true };
  }

  if (capability === 'modelSize') {
    if (value > plan.limits.maxModelSizeGb) {
      return {
        allowed: false,
        reason:  `Model size ${value} GB exceeds ${plan.name} plan limit of ${plan.limits.maxModelSizeGb} GB.`,
        upgrade: 'team',
      };
    }
    return { allowed: true };
  }

  if (capability === 'streaming') {
    if (!plan.limits.streamingEnabled) {
      return { allowed: false, reason: 'Streaming requires Pro plan or higher.', upgrade: 'pro' };
    }
    return { allowed: true };
  }

  if (capability === 'api') {
    if (!plan.limits.apiAccess) {
      return { allowed: false, reason: 'API access requires Pro plan or higher.', upgrade: 'pro' };
    }
    return { allowed: true };
  }

  return { allowed: true };
}

// ─── Stripe integration ───────────────────────────────────────────────────────

let stripe = null;
function getStripe() {
  if (!isPricingEnabled()) return null;
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not set');
    stripe = require('stripe')(key);
  }
  return stripe;
}

async function createCheckoutSession({ planId, period = 'monthly', userId, successUrl, cancelUrl }) {
  if (!isPricingEnabled()) throw new Error('Pricing is disabled');

  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);

  const priceId = period === 'yearly' ? plan.stripeYearlyPriceId : plan.stripeMonthlyPriceId;
  if (!priceId) throw new Error(`Plan ${planId} has no ${period} price`);

  const s = getStripe();
  return s.checkout.sessions.create({
    mode:        'subscription',
    line_items:  [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url:  cancelUrl,
    metadata:    { userId, planId, period },
  });
}

async function createPortalSession({ customerId, returnUrl }) {
  if (!isPricingEnabled()) throw new Error('Pricing is disabled');
  const s = getStripe();
  return s.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
}

async function handleWebhook(rawBody, signature) {
  if (!isPricingEnabled()) return { received: true };
  const s       = getStripe();
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;
  const event   = s.webhooks.constructEvent(rawBody, signature, secret);

  switch (event.type) {
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const sub    = event.data.object;
      const planId = sub.metadata?.planId ?? 'free';
      // TODO: update user record in DB
      return { action: 'plan_updated', planId, customerId: sub.customer };
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      return { action: 'plan_cancelled', customerId: sub.customer };
    }
    default:
      return { received: true };
  }
}

// ─── Express middleware ───────────────────────────────────────────────────────

function pricingGuard(capability, getValue = () => null) {
  return (req, res, next) => {
    if (!isPricingEnabled()) return next();

    const value  = getValue(req);
    const result = checkLimit(req.user, capability, value);

    if (!result.allowed) {
      return res.status(402).json({
        error:   'plan_limit_exceeded',
        message: result.reason,
        upgrade: result.upgrade,
        plans:   Object.fromEntries(
          Object.entries(PLANS)
            .filter(([id]) => id !== 'open')
            .map(([id, p]) => [id, { name: p.name, priceMonthly: p.priceMonthly }])
        ),
      });
    }
    next();
  };
}

module.exports = {
  isPricingEnabled,
  getEffectivePlan,
  checkLimit,
  createCheckoutSession,
  createPortalSession,
  handleWebhook,
  pricingGuard,
  PLANS,
};
