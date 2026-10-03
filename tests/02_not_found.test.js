const request = require('supertest');
const app = require('../src/app');

describe('Test 2: 404 Route Handling', () => {
  it('GET /api/v1/non-existent-route - should return 404 Not Found', async () => {
    const res = await request(app).get('/api/v1/non-existent-route');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toHaveProperty('message');
  });
});
