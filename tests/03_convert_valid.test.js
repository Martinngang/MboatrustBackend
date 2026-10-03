const request = require('supertest');
const app = require('../src/app');

describe('Test 3: Currency Conversion (Valid)', () => {
  it('GET /api/v1/tools/convert - should calculate valid currency conversion', async () => {
    const res = await request(app)
      .get('/api/v1/tools/convert')
      .query({ amount: 100, from: 'USD', to: 'USD' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('convertedAmount', 100);
    expect(res.body.data).toHaveProperty('rate', 1);
  });
});
