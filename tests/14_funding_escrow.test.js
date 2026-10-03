const request = require('supertest');
const app = require('../src/app');
const { User, Project } = require('../src/models');

describe('Test 14: Funding Through Escrow', () => {
  let funder;
  let project;

  beforeAll(async () => {
    funder = await User.findOneAndUpdate(
      { email: 'test-funding-funder@mboatrust.test' },
      {
        fullName: 'Test Funding Funder',
        email: 'test-funding-funder@mboatrust.test',
        firebaseUid: 'test-funding-funder-uid',
        roles: [{ roleType: 'funder' }],
      },
      { upsert: true, new: true }
    );

    project = await Project.create({
      projectType: 'tender',
      status: 'in_progress',
      ownerId: funder._id,
      title: 'Solar Installation Escrow Funding',
      totalAmount: 100000,
      currency: 'XAF',
      milestones: [{ name: 'Equipment Procurement', amount: 100000, orderIndex: 0 }],
    });
  });

  it('1. POST /api/v1/projects/:id/fund - deposits funds into escrow', async () => {
    const payload = {
      amount: 100000,
      paymentProvider: 'mtn_momo',
      currency: 'XAF',
      payerPhoneNumber: '+237677000111',
    };

    const res = await request(app)
      .post(`/api/v1/projects/${project._id}/fund`)
      .set('x-dev-user-id', String(funder._id))
      .set('idempotency-key', `fund-escrow-${Date.now()}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('type', 'fund');
    expect(res.body.data).toHaveProperty('status', 'completed');
    expect(res.body.data.grossAmount).toBe(100000);
    expect(res.body.data.netAmount).toBeGreaterThan(90000);
  });

  it('2. GET /api/v1/projects/:id/funding-summary - reflects deposited escrow balance', async () => {
    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/funding-summary`)
      .set('x-dev-user-id', String(funder._id));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.fundedAmount).toBeGreaterThan(0);
  });
});
