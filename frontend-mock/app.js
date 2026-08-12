// Frontend integration for the real fund-project flow
const BASE_USD_RATES = { USD: 1, EUR: 1.05, GBP: 1.25, XAF: 0.001625 };
const FEES = { project_funding: 0.02, currency_conversion: 0.015 };
let stripeInstance = null;
let stripeCard = null;

function buildFxRate(from, to) {
  if (from === to) return 1;
  const s = BASE_USD_RATES[from];
  const t = BASE_USD_RATES[to];
  if (!s || !t) return 1;
  return s / t;
}

function $(id) { return document.getElementById(id); }

function renderSummary() {
  const amount = Number($('amount').value) || 0;
  const currency = $('currency').value;
  const paymentProvider = $('paymentProvider').value;

  const feeAmount = Math.round(amount * FEES.project_funding * 100) / 100;
  const net = Math.round((amount - feeAmount) * 100) / 100;

  const lines = [];
  lines.push(`<div>You are paying: <strong>${amount} ${currency}</strong></div>`);
  if (currency !== 'XAF') {
    const rate = buildFxRate(currency, 'XAF');
    const converted = Math.round(net * rate * 100) / 100;
    const convFee = Math.round(converted * FEES.currency_conversion * 100) / 100;
    const settled = Math.round((converted - convFee) * 100) / 100;
    lines.push(`<div>Estimated local equivalent: <strong>${converted} XAF</strong> (rate ${rate.toFixed(6)})</div>`);
    lines.push(`<div>Conversion fee: <strong>${convFee} XAF</strong></div>`);
    lines.push(`<div>Net to escrow (local): <strong>${settled} XAF</strong></div>`);
  } else {
    lines.push(`<div>Net to escrow: <strong>${net} XAF</strong></div>`);
  }
  lines.push(`<div>Platform fee: <strong>${feeAmount} ${currency}</strong></div>`);
  lines.push(`<div style="margin-top:8px;color:#333">This funding will be collected via <strong>${$('paymentProvider').selectedOptions[0].text}</strong> and later disbursed to recipients via mobile money.</div>`);

  $('summaryLines').innerHTML = lines.join('');
}

function showResult(obj) {
  $('result').textContent = '';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(obj, null, 2);
  $('result').appendChild(pre);
}

function appendHistory(text, data) {
  const div = document.createElement('div');
  div.className = 'entry';
  div.innerHTML = `<div>${text}</div><pre>${JSON.stringify(data || {}, null, 2)}</pre>`;
  $('history').prepend(div);
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function setCardSectionVisible(visible) {
  const cardSection = $('cardSection');
  cardSection.style.display = visible ? 'block' : 'none';
  if (!visible) {
    $('cardError').textContent = '';
  }
}

function togglePaymentFields() {
  const p = $('paymentProvider').value;
  if (p === 'mtn_momo' || p === 'orange_money') {
    $('payerPhoneLabel').style.display = 'block';
    setCardSectionVisible(false);
  } else if (p === 'stripe') {
    $('payerPhoneLabel').style.display = 'none';
    setCardSectionVisible(true);
  } else {
    $('payerPhoneLabel').style.display = 'none';
    setCardSectionVisible(false);
  }
  renderSummary();
}

async function loadStripeInstance() {
  const pk = $('stripePublishableKey').value.trim();
  if (!pk) throw new Error('Enter a Stripe publishable key to confirm a card payment.');
  if (!window.Stripe) throw new Error('Stripe.js did not load.');
  if (!stripeInstance || stripeInstance._pk !== pk) {
    stripeInstance = window.Stripe(pk);
    stripeInstance._pk = pk;
  }
  return stripeInstance;
}

function ensureCardElement() {
  if (stripeCard) return stripeCard;
  const stripe = stripeInstance || null;
  if (!stripe) return null;
  const elements = stripe.elements();
  stripeCard = elements.create('card', { style: { base: { fontSize: '16px', color: '#111', '::placeholder': { color: '#999' } } } });
  stripeCard.mount($('cardElement'));
  return stripeCard;
}

async function confirmStripeCard(clientSecret) {
  const stripe = await loadStripeInstance();
  const card = ensureCardElement();
  if (!card) throw new Error('Stripe card field could not be initialized.');
  $('cardError').textContent = '';
  const result = await stripe.confirmCardPayment(clientSecret, {
    payment_method: {
      card,
      billing_details: { name: 'Demo payer', email: 'demo@example.com' },
    },
  });
  if (result.error) throw new Error(result.error.message || 'Card payment failed.');
  return result.paymentIntent;
}

async function confirmPayment() {
  const backendUrl = $('backendUrl').value.replace(/\/$/, '');
  const projectId = $('projectId').value.trim();
  if (!projectId) return alert('Enter project id to fund');

  const body = {
    amount: Number($('amount').value) || 0,
    paymentProvider: $('paymentProvider').value,
    currency: $('currency').value,
  };
  const payerPhone = $('payerPhone').value.trim();
  if (body.paymentProvider === 'mtn_momo' || body.paymentProvider === 'orange_money') {
    if (!payerPhone) return alert('Payer phone number is required for mobile money funding');
    body.payerPhoneNumber = payerPhone;
  }

  const idempotency = uuidv4();
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': idempotency };
  const devUser = $('devUserId').value.trim();
  headers['x-dev-user-id'] = devUser || '6a770027d516f53a98f1ab77';

  appendHistory('Initiating collection (client -> platform)', { request: body });
  try {
    const resp = await fetch(`${backendUrl}/api/v1/projects/${projectId}/fund`, { method: 'POST', body: JSON.stringify(body), headers });
    const json = await resp.json();
    if (!json.success) throw json.error || json;
    const data = json.data || {};

    if (body.paymentProvider === 'stripe' && data.clientSecret) {
      appendHistory('Stripe payment intent created', data);
      const paymentIntent = await confirmStripeCard(data.clientSecret);
      appendHistory('Stripe confirmation completed', paymentIntent);
      showResult({ success: true, paymentIntent });
      return;
    }

    if (body.paymentProvider === 'flutterwave' && data.paymentUrl) {
      appendHistory('Flutterwave payment redirect ready', data);
      window.location.assign(data.paymentUrl);
      return;
    }

    appendHistory('Collected (platform) — escrow created', data);
    showResult(json);
  } catch (err) {
    appendHistory('Collection failed', err);
    showResult({ error: String(err) });
  }
}

// UI wiring
$('paymentProvider').addEventListener('change', togglePaymentFields);
['amount','currency','stripePublishableKey'].forEach(id => $(id).addEventListener('input', renderSummary));
$('confirm').addEventListener('click', confirmPayment);

// initial render
$('paymentProvider').dispatchEvent(new Event('change'));
renderSummary();
