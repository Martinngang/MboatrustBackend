const request = require('supertest');
const app = require('../src/app');

describe('Test 10: Public Contractor Leaderboard', () => {
  it('GET /api/v1/contractor-profiles/leaderboard - should return 200 with ranking list', async () => {
    const res = await request(app).get('/api/v1/contractor-profiles/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty('meta');
  });
});
