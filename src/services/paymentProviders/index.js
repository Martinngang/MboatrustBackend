const mtnMomoProvider = require('./mtnMomoProvider');
const orangeMoneyProvider = require('./orangeMoneyProvider');
const flutterwaveProvider = require('./flutterwaveProvider');

const providers = {
  [mtnMomoProvider.name]: mtnMomoProvider,
  [orangeMoneyProvider.name]: orangeMoneyProvider,
  [flutterwaveProvider.name]: flutterwaveProvider,
};

function getPaymentProvider(name) {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unsupported payment provider "${name}"`);
  }
  return provider;
}

module.exports = { getPaymentProvider, providers };
