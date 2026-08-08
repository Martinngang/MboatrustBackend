# Dual-Rail Payment Architecture

## PaymentProvider interface design

The backend now models each payment rail as a provider adapter with an explicit collection/disbursement contract.

### `PaymentProvider` interface

Each provider adapter implements:

- `name`: the provider identifier string, e.g. `mtn_momo`, `orange_money`, `flutterwave`
- `supportsCollect`: whether the provider can receive funds from a payer
- `supportsDisburse`: whether the provider can send funds to a payee
- `collect(params)`: initiates or mocks a payment collection
- `disburse(params)`: initiates or mocks a payment disbursement
- `refreshStatus?(providerReference, product)`: optional provider-specific status refresh for pending transactions

### `collect(params)` contract

Params:
- `amount`: number
- `currency`: string (USD/EUR/GBP/XAF)
- `externalId`: string
- `payerPhoneNumber?`: string, when the provider requires an MSISDN payer

Result:
- `provider`: provider name
- `providerReference`: provider-specific transaction reference
- `status`: `pending | completed | failed`
- `amount`: original amount
- `currency`: payment currency
- `externalId`: external ID
- `paymentUrl?`: optional redirect URL for redirect-based flows
- `payerPhoneNumber?`

### `disburse(params)` contract

Params:
- `amount`: number
- `currency`: string
- `externalId`: string
- `payeePhoneNumber`: string

Result:
- `provider`: provider name
- `providerReference`: provider-specific transaction reference
- `status`: `pending | completed | failed`
- `amount`: disbursement amount
- `currency`: payout currency
- `externalId`: external ID
- `payeePhoneNumber?`

### Supported provider adapters

- `mtn_momo`: supports both `collect()` and `disburse()` for Cameroon mobile money flows
- `orange_money`: supports collection and mocked disbursement for the current sandbox stage
- `flutterwave`: supports international collection via card/bank transfer for mock stage. This adapter is the recommended choice for the diaspora funder leg because Flutterwave can later extend to local African disbursements in the same partner integration.

### Recommendation and tradeoff

- Use **Flutterwave** for the international collection leg in this architecture. It already supports cards and bank transfers across multiple currencies and can grow to provide local African disbursements in the same integration, which reduces integration surface compared to Stripe plus separate MoMo/Orange adapters.
- A **Stripe**-only collection path is also viable if the platform wants a strictly card-first international checkout, but it would still require separate Cameroon payout rails for MoMo/Orange Money.

## Updated fund project screen (mock stage)

The funding screen should clearly separate the funder leg from the payout leg.

### Payment method selector

- `International payment` group:
  - Card / bank transfer (via Flutterwave)
- `Cameroon mobile money` group:
  - MTN MoMo
  - Orange Money

### Currency selector

Allow funders to choose:
- USD
- EUR
- GBP
- XAF

### Input fields

- Amount payable in the selected currency
- Optional payer mobile money number when the funder chooses MTN MoMo or Orange Money

### Summary panel

Show a split summary before confirmation:
- `You are paying`: `120 USD`
- `Estimated local equivalent`: `75,000 XAF`
- `Platform fee`: `3,000 XAF` (or `2.5 USD` depending on display preference)
- `Net to escrow`: `72,000 XAF`
- Provider note: `This payment will be collected internationally and later disbursed locally via mobile money.`

### Tooltip help text

Add a short explanatory note near the funding section:

> Pay with your card from anywhere — we handle the transfer to Cameroon via mobile money.

### Transaction history UI

Mock the split by showing both legs when relevant:
- `Collected 120 USD via Flutterwave`
- `Disbursed 75,000 XAF via MTN MoMo`
- `Conversion and fees`: `1 USD = 625 XAF, +2% conversion spread, 3% payout fee`

This document should be used as the base for wiring the frontend mock screen and for incrementally replacing the mock adapters with real Stripe/Flutterwave and MoMo/OM integrations later.
