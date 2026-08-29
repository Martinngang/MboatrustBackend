/**
 * Resolves available payment methods for a user based on their residenceCountry.
 * Used by the frontend checkout to display the correct payment options.
 */
function getAvailablePaymentMethods(user) {
  const country = (user.residenceCountry || 'CM').toUpperCase();
  const isCameroon = country === 'CM';
  const methods = [];

  if (isCameroon) {
    methods.push(
      { id: 'mtn_momo', label: 'MTN Mobile Money', icon: 'mtn', requiresPhone: true, brandColor: '#FFCC00' },
      { id: 'orange_money', label: 'Orange Money', icon: 'orange', requiresPhone: true, brandColor: '#FF6600' },
    );
  }

  if (!isCameroon) {
    methods.push(
      { id: 'stripe', label: 'Card Payment', icon: 'stripe', requiresPhone: false, brandColor: '#635BFF' },
      { id: 'flutterwave', label: 'Pay with Flutterwave', icon: 'flutterwave', requiresPhone: false, brandColor: '#F5A623' },
    );
  }

  // Cameroon users can also use Flutterwave card as backup
  if (isCameroon) {
    methods.push(
      { id: 'flutterwave', label: 'Pay with Card', icon: 'flutterwave', requiresPhone: false, brandColor: '#F5A623' },
    );
  }

  return {
    country,
    isCameroon,
    defaultCurrency: isCameroon ? 'XAF' : 'EUR',
    methods,
  };
}

module.exports = { getAvailablePaymentMethods };
