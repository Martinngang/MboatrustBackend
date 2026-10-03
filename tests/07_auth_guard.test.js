const request = require('supertest');
const app = require('../src/app');

describe('Test 7: Authentication Guard', () => {
  it('GET /api/v1/users/me - should return 401 Unauthorized when missing auth header', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toMatch(/missing/i);
  });
});
