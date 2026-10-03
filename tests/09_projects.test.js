const request = require('supertest');
const app = require('../src/app');

describe('Test 9: Public Projects Listing', () => {
  it('GET /api/v1/projects - should return 200 with paginated projects', async () => {
    const res = await request(app).get('/api/v1/projects');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toHaveProperty('page', 1);
  });
});
