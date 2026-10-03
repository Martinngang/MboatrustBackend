const request = require('supertest');
const app = require('../src/app');

describe('Test 8: Public Fee Configuration', () => {
  it('GET /api/v1/fee-config - should return 200 with platform fee configurations', async () => {
    const res = await request(app).get('/api/v1/fee-config');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
