/**
 * test-payments.js
 * End-to-end sandbox verification test suite for MboaTrust multi-method payment system.
 */
const { connectDB } = require('../config/db');
const paymentService = require('../services/paymentService');
const conversionService = require('../services/conversionService');
const feeService = require('../services/feeService');
const { getAvailablePaymentMethods } = require('../services/paymentMethodService');

async function runTests() {
  console.log('--- STARTING MBOATRUST PAYMENT SYSTEM E2E TESTS ---');
  let passCount = 0;
  let failCount = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✅ PASS: ${message}`);
      passCount++;
    } else {
      console.error(`❌ FAIL: ${message}`);
      failCount++;
    }
  }

  try {
    await connectDB();
    console.log('Database connected.');

    // 1. Test Payment Method Routing
    console.log('\n--- 1. Geo-Aware Payment Method Routing ---');
    const cmUser = { residenceCountry: 'CM' };
    const cmRouting = getAvailablePaymentMethods(cmUser);
    assert(cmRouting.isCameroon === true, 'CM user identified as Cameroon resident');
    assert(cmRouting.methods.some((m) => m.id === 'mtn_momo'), 'CM user has MTN MoMo');
    assert(cmRouting.methods.some((m) => m.id === 'orange_money'), 'CM user has Orange Money');

    const frUser = { residenceCountry: 'FR' };
    const frRouting = getAvailablePaymentMethods(frUser);
    assert(frRouting.isCameroon === false, 'FR user identified as Diaspora/International');
    assert(frRouting.methods.some((m) => m.id === 'stripe'), 'FR user has Stripe');
    assert(frRouting.methods.some((m) => m.id === 'flutterwave'), 'FR user has Flutterwave');

    // 2. Test Currency Conversion Service
    console.log('\n--- 2. Currency Conversion Service ---');
    const convEUR = await conversionService.convertAmount(100, 'EUR', 'XAF');
    assert(convEUR.fromCurrency === 'EUR' && convEUR.toCurrency === 'XAF', 'EUR to XAF conversion currencies set');
    assert(convEUR.rate > 600, `EUR to XAF rate looks valid (${convEUR.rate})`);
    assert(convEUR.convertedAmount > 60000, `Converted 100 EUR = ${convEUR.convertedAmount} XAF`);

    const convSame = await conversionService.convertAmount(10000, 'XAF', 'XAF');
    assert(convSame.rate === 1 && convSame.convertedAmount === 10000, 'Same currency conversion rate is 1');

    // 3. Test Fee Calculation Service
    console.log('\n--- 3. Fee Calculation Service ---');
    const feeFund = await feeService.calculateFee('project_funding', 1000000, 'XAF');
    assert(feeFund.grossAmount === 1000000, 'Gross amount matches');
    assert(feeFund.feeAmount >= 0 && feeFund.netAmount <= 1000000, `Net amount calculated (${feeFund.netAmount})`);

    // 4. Test Payment Providers Collect (Sandbox Mode)
    console.log('\n--- 4. Payment Provider Collect Adapters ---');
    const momoCol = await paymentService.collect('mtn_momo', {
      amount: 50000,
      currency: 'XAF',
      payerPhoneNumber: '+237670000000',
      externalId: 'test_momo_col',
    });
    assert(momoCol.provider === 'mtn_momo' && momoCol.status === 'completed', 'MTN MoMo collection sandbox succeeded');

    const omCol = await paymentService.collect('orange_money', {
      amount: 50000,
      currency: 'XAF',
      payerPhoneNumber: '+237690000000',
      externalId: 'test_om_col',
    });
    assert(omCol.provider === 'orange_money', 'Orange Money collection adapter responded');

    const stripeCol = await paymentService.collect('stripe', {
      amount: 100,
      currency: 'EUR',
      externalId: 'test_stripe_col',
      email: 'test@mboatrust.com',
    });
    assert(stripeCol.provider === 'stripe', 'Stripe collection adapter responded');

    const flwCol = await paymentService.collect('flutterwave', {
      amount: 100,
      currency: 'USD',
      externalId: 'test_flw_col',
      email: 'test@mboatrust.com',
    });
    assert(flwCol.provider === 'flutterwave', 'Flutterwave collection adapter responded');

    // 5. Test Payment Providers Disburse
    console.log('\n--- 5. Payment Provider Disbursement Adapters ---');
    const momoDisb = await paymentService.disburse('mtn_momo', {
      amount: 45000,
      currency: 'XAF',
      payeePhoneNumber: '+237670000000',
      externalId: 'test_momo_disb',
    });
    assert(momoDisb.provider === 'mtn_momo' && momoDisb.status === 'completed', 'MTN MoMo disbursement sandbox succeeded');

    const omDisb = await paymentService.disburse('orange_money', {
      amount: 45000,
      currency: 'XAF',
      payeePhoneNumber: '+237690000000',
      externalId: 'test_om_disb',
    });
    assert(omDisb.provider === 'orange_money' && omDisb.status === 'completed', 'Orange Money disbursement sandbox succeeded');

    console.log(`\n========================================`);
    console.log(`TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
    console.log(`========================================`);

  } catch (err) {
    console.error('Test execution error:', err);
  } finally {
    process.exit(failCount > 0 ? 1 : 0);
  }
}

runTests();
