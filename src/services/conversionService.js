const feeService = require('./feeService');

const BASE_USD_RATES = {
  USD: 1,
  EUR: 1.05,
  GBP: 1.25,
  XAF: 0.001625,
};

function buildFxRate(fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return 1;
  const sourceRate = BASE_USD_RATES[fromCurrency];
  const targetRate = BASE_USD_RATES[toCurrency];
  if (!sourceRate || !targetRate) {
    throw new Error(`Unsupported currency conversion from ${fromCurrency} to ${toCurrency}`);
  }
  return sourceRate / targetRate;
}

async function convertAmount(amount, fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) {
    return {
      fromCurrency,
      toCurrency,
      rate: 1,
      amountBeforeConversion: amount,
      convertedAmount: amount,
      conversionFee: 0,
      settledAmount: amount,
      feeBreakdown: null,
    };
  }

  const rate = buildFxRate(fromCurrency, toCurrency);
  const convertedAmount = Math.round(amount * rate * 100) / 100;
  const fee = await feeService.calculateFee('currency_conversion', convertedAmount, toCurrency);

  return {
    fromCurrency,
    toCurrency,
    rate,
    amountBeforeConversion: amount,
    convertedAmount,
    conversionFee: fee.feeAmount,
    settledAmount: fee.netAmount,
    feeBreakdown: fee,
  };
}

module.exports = { convertAmount };
