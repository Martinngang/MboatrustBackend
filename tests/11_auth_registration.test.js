const request = require('supertest');
const app = require('../src/app');

describe('Test 11: Login & Registration (Auth)', () => {
  let userId;

  it('1. Provision/Login demo user via dev endpoint', async () => {
    const res = await request(app)
      .get('/api/v1/dev/demo-user')
      .query({ role: 'funder' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('userId');
    userId = res.body.data.userId;
  });

  it('2. GET /api/v1/users/me with dev auth header returns authenticated user', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('x-dev-user-id', userId);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('_id', userId);
    expect(res.body.data).toHaveProperty('email');
  });

  it('3. PATCH /api/v1/users/me updates profile details', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('x-dev-user-id', userId)
      .send({ fullName: 'Updated Demo Funder' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('fullName', 'Updated Demo Funder');
  });
});
