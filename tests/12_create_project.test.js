const request = require('supertest');
const app = require('../src/app');
const { User } = require('../src/models');

describe('Test 12: Project Creation', () => {
  let funder;
  let createdProjectId;

  beforeAll(async () => {
    funder = await User.findOneAndUpdate(
      { email: 'test-project-funder@mboatrust.test' },
      {
        fullName: 'Test Project Funder',
        email: 'test-project-funder@mboatrust.test',
        firebaseUid: 'test-funder-proj-uid',
        roles: [{ roleType: 'funder' }],
      },
      { upsert: true, new: true }
    );
  });

  it('1. POST /api/v1/projects creates a new tender project with milestones', async () => {
    const payload = {
      projectType: 'tender',
      title: 'Water Well Construction Test',
      description: 'Building a 50m borehole in Douala',
      category: 'Water & Sanitation',
      locationName: 'Douala, Cameroon',
      totalAmount: 150000,
      currency: 'XAF',
      milestones: [
        { name: 'Drilling', amount: 75000, orderIndex: 0 },
        { name: 'Pump Installation', amount: 75000, orderIndex: 1 },
      ],
    };

    const res = await request(app)
      .post('/api/v1/projects')
      .set('x-dev-user-id', String(funder._id))
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('_id');
    expect(res.body.data.title).toBe(payload.title);
    expect(res.body.data.totalAmount).toBe(payload.totalAmount);
    expect(res.body.data.milestones.length).toBe(2);

    createdProjectId = res.body.data._id;
  });

  it('2. GET /api/v1/projects/:id fetches the created project details', async () => {
    const res = await request(app).get(`/api/v1/projects/${createdProjectId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id).toBe(createdProjectId);
    expect(res.body.data.milestones.length).toBe(2);
  });
});
