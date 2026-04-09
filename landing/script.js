'use strict';

/* ── Nav scroll effect ──────────────────────────────────────────────────────── */
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.style.borderBottomColor = window.scrollY > 10 ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.04)';
}, { passive: true });

/* ── Mobile burger menu ─────────────────────────────────────────────────────── */
const burger  = document.getElementById('navBurger');
const navLinks = document.querySelector('.nav__links');
burger?.addEventListener('click', () => {
  navLinks.classList.toggle('open');
});
document.querySelectorAll('.nav__links a').forEach(a => {
  a.addEventListener('click', () => navLinks.classList.remove('open'));
});

/* ── Terminal typing animation ──────────────────────────────────────────────── */
const typingCursor = document.getElementById('typingCursor');
const phrases = [
  'Explain quantum entanglement simply',
  'Write a Python web scraper',
  'Summarize this PDF document',
  'Debug my JavaScript code',
  'Draft a product launch email',
];
let phraseIdx = 0;
let charIdx   = 0;
let deleting  = false;
let pause     = false;

function typeNext() {
  if (!typingCursor) return;
  if (pause) { pause = false; setTimeout(typeNext, 1400); return; }

  const phrase = phrases[phraseIdx];

  if (!deleting && charIdx <= phrase.length) {
    typingCursor.previousSibling
      ? typingCursor.previousSibling.textContent = phrase.slice(0, charIdx)
      : typingCursor.insertAdjacentText('beforebegin', phrase.slice(0, charIdx));
    charIdx++;
    if (charIdx > phrase.length) { deleting = true; pause = true; }
    setTimeout(typeNext, 60);
  } else if (deleting && charIdx >= 0) {
    const prev = typingCursor.previousSibling;
    if (prev && prev.nodeType === Node.TEXT_NODE) {
      prev.textContent = phrase.slice(0, charIdx);
    }
    charIdx--;
    if (charIdx < 0) {
      deleting = false;
      phraseIdx = (phraseIdx + 1) % phrases.length;
      charIdx = 0;
      pause = true;
    }
    setTimeout(typeNext, 30);
  }
}

// Ensure there's a text node before the cursor
if (typingCursor) {
  typingCursor.insertAdjacentText('beforebegin', '');
  setTimeout(typeNext, 1000);
}

/* ── Code tabs ──────────────────────────────────────────────────────────────── */
document.querySelectorAll('.code-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.code-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.code-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
  });
});

/* ── Pricing toggle (monthly ↔ yearly) ──────────────────────────────────────── */
const toggleBtn     = document.getElementById('billingToggle');
const monthlyLabel  = document.getElementById('monthlyLabel');
const yearlyLabel   = document.getElementById('yearlyLabel');
let isYearly = false;

toggleBtn?.addEventListener('click', () => {
  isYearly = !isYearly;
  toggleBtn.classList.toggle('active', isYearly);
  monthlyLabel.style.opacity = isYearly ? '.5' : '1';
  yearlyLabel.style.fontWeight = isYearly ? '700' : '400';

  document.querySelectorAll('.plan-price__amount[data-monthly]').forEach(el => {
    const monthly = parseFloat(el.dataset.monthly);
    const yearly  = parseFloat(el.dataset.yearly);
    if (isNaN(monthly)) return;
    if (monthly === 0) { el.textContent = '$0'; return; }
    el.textContent = isYearly ? `$${yearly}` : `$${monthly}`;
  });

  document.querySelectorAll('.plan-price__per').forEach(el => {
    el.textContent = isYearly ? '/month, billed yearly' : '/month';
  });
});

/* ── Intersection observer — animate on scroll ──────────────────────────────── */
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.style.animationPlayState = 'running';
      io.unobserve(e.target);
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.feature-card, .bench-card, .plan-card, .how-step').forEach(el => {
  el.style.animationPlayState = 'paused';
  el.style.animation = 'fadeUp .6s ease both';
  io.observe(el);
});

/* ── Benchmark bars animate on scroll ───────────────────────────────────────── */
const barObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.querySelectorAll('.bench-bar').forEach((bar, i) => {
        bar.style.animationDelay = `${i * 0.1}s`;
        bar.style.animationPlayState = 'running';
      });
      barObserver.unobserve(e.target);
    }
  });
}, { threshold: 0.3 });

document.querySelectorAll('.bench-card').forEach(el => {
  el.querySelectorAll('.bench-bar').forEach(b => { b.style.animationPlayState = 'paused'; });
  barObserver.observe(el);
});

/* ── Smooth scroll for anchor links ─────────────────────────────────────────── */
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});
