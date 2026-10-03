const request = require('supertest');
const app = require('../src/app');

describe('Test 1: Health Check', () => {
  it('GET /health - should return 200 with service health and db status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('db');
    expect(res.body.db.connected).toBe(true);
  });
});
