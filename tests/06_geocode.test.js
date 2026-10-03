const request = require('supertest');
const app = require('../src/app');

describe('Test 6: Geocoding Tool (Validation)', () => {
  it('GET /api/v1/tools/geocode - should return 400 when query is missing', async () => {
    const res = await request(app).get('/api/v1/tools/geocode');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toMatch(/query is required/i);
  });
});
