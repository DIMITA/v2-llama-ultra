'use strict';

/**
 * plans.js
 * Pricing plan definitions.
 * If PRICING_ENABLED=false these are never consulted.
 */

const PLANS = {
  free: {
    id:          'free',
    name:        'Free',
    priceMonthly: 0,
    priceYearly:  0,
    stripeMonthlyPriceId: null,
    stripeYearlyPriceId:  null,
    limits: {
      requestsPerDay:   50,
      maxModelSizeGb:   7,
      quantizations:    ['int4'],
      streamingEnabled: false,
      apiAccess:        false,
      prioritySupport:  false,
      commercialUse:    false,
    },
    description: 'Get started — run lightweight models on your machine',
  },

  pro: {
    id:           'pro',
    name:         'Pro',
    priceMonthly: 19,
    priceYearly:  190,   // ~2 months free
    stripeMonthlyPriceId: process.env.STRIPE_PRO_MONTHLY_PRICE_ID ?? 'price_pro_monthly',
    stripeYearlyPriceId:  process.env.STRIPE_PRO_YEARLY_PRICE_ID  ?? 'price_pro_yearly',
    limits: {
      requestsPerDay:   2000,
      maxModelSizeGb:   30,
      quantizations:    ['int4', 'int8', 'fp16'],
      streamingEnabled: true,
      apiAccess:        true,
      prioritySupport:  false,
      commercialUse:    true,
    },
    description: 'For developers & power users — full quantization, API access',
  },

  team: {
    id:           'team',
    name:         'Team',
    priceMonthly: 79,
    priceYearly:  790,
    stripeMonthlyPriceId: process.env.STRIPE_TEAM_MONTHLY_PRICE_ID ?? 'price_team_monthly',
    stripeYearlyPriceId:  process.env.STRIPE_TEAM_YEARLY_PRICE_ID  ?? 'price_team_yearly',
    limits: {
      requestsPerDay:   20000,
      maxModelSizeGb:   70,
      quantizations:    ['int4', 'int8', 'fp16', 'fp32'],
      streamingEnabled: true,
      apiAccess:        true,
      prioritySupport:  true,
      commercialUse:    true,
      seats:            5,
    },
    description: 'For small teams — all features, priority support',
  },

  enterprise: {
    id:           'enterprise',
    name:         'Enterprise',
    priceMonthly: null,  // custom
    priceYearly:  null,
    stripeMonthlyPriceId: null,
    stripeYearlyPriceId:  null,
    limits: {
      requestsPerDay:   Infinity,
      maxModelSizeGb:   Infinity,
      quantizations:    ['int4', 'int8', 'fp16', 'fp32'],
      streamingEnabled: true,
      apiAccess:        true,
      prioritySupport:  true,
      commercialUse:    true,
      sso:              true,
      audit:            true,
      onPremise:        true,
    },
    description: 'Custom deployment — on-premise, SLA, dedicated support',
  },

  // Special "open" plan — no billing, no limits — used when pricing is disabled
  open: {
    id:           'open',
    name:         'Open / Self-Hosted',
    priceMonthly: 0,
    priceYearly:  0,
    stripeMonthlyPriceId: null,
    stripeYearlyPriceId:  null,
    limits: {
      requestsPerDay:   Infinity,
      maxModelSizeGb:   Infinity,
      quantizations:    ['int4', 'int8', 'fp16', 'fp32'],
      streamingEnabled: true,
      apiAccess:        true,
      prioritySupport:  false,
      commercialUse:    true,
    },
    description: 'All features unlocked — billing disabled',
  },
};

module.exports = { PLANS };
