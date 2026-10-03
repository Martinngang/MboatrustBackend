const request = require('supertest');
const app = require('../src/app');

describe('Test 5: Currency Conversion (Negative Amount)', () => {
  it('GET /api/v1/tools/convert - should return 400 when amount is negative', async () => {
    const res = await request(app)
      .get('/api/v1/tools/convert')
      .query({ amount: -50, from: 'USD', to: 'XAF' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toMatch(/amount must be a non-negative number/i);
  });
});
