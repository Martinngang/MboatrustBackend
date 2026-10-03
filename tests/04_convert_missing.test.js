const request = require('supertest');
const app = require('../src/app');

describe('Test 4: Currency Conversion (Missing Query Params)', () => {
  it('GET /api/v1/tools/convert - should return 400 when query params are missing', async () => {
    const res = await request(app).get('/api/v1/tools/convert');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toMatch(/amount, from, and to are required/i);
  });
});
