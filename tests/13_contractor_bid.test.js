const request = require('supertest');
const app = require('../src/app');
const { User, Project, ContractorProfile } = require('../src/models');

describe('Test 13: Contractor Submitting a Bid', () => {
  let funder;
  let contractor;
  let tenderProject;
  let createdBidId;

  beforeAll(async () => {
    funder = await User.findOneAndUpdate(
      { email: 'test-bid-funder@mboatrust.test' },
      {
        fullName: 'Test Bid Funder',
        email: 'test-bid-funder@mboatrust.test',
        firebaseUid: 'test-bid-funder-uid',
        roles: [{ roleType: 'funder' }],
      },
      { upsert: true, new: true }
    );

    contractor = await User.findOneAndUpdate(
      { email: 'test-bid-contractor@mboatrust.test' },
      {
        fullName: 'Test Bid Contractor',
        email: 'test-bid-contractor@mboatrust.test',
        firebaseUid: 'test-bid-contractor-uid',
        roles: [{ roleType: 'contractor' }],
      },
      { upsert: true, new: true }
    );

    await ContractorProfile.findOneAndUpdate(
      { userId: contractor._id },
      { userId: contractor._id, categories: ['Water & Sanitation'], isAvailable: true },
      { upsert: true, new: true }
    );

    tenderProject = await Project.create({
      projectType: 'tender',
      status: 'open',
      ownerId: funder._id,
      title: 'Borehole Drilling Tender',
      category: 'Water & Sanitation',
      totalAmount: 150000,
      currency: 'XAF',
      milestones: [{ name: 'Phase 1 Drilling', amount: 150000, orderIndex: 0 }],
    });
  });

  it('1. POST /api/v1/bids - contractor submits a bid on a tender', async () => {
    const payload = {
      projectId: String(tenderProject._id),
      price: 140000,
      timelineDays: 20,
      notes: 'Fully equipped drilling rig ready in Douala',
    };

    const res = await request(app)
      .post('/api/v1/bids')
      .set('x-dev-user-id', String(contractor._id))
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('_id');
    expect(res.body.data.price).toBe(140000);
    expect(res.body.data.status).toBe('submitted');

    createdBidId = res.body.data._id;
  });

  it('2. PATCH /api/v1/bids/:id/status - funder accepts the submitted bid', async () => {
    const res = await request(app)
      .patch(`/api/v1/bids/${createdBidId}/status`)
      .set('x-dev-user-id', String(funder._id))
      .set('idempotency-key', `accept-bid-${Date.now()}`)
      .send({ status: 'accepted' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.bid.status).toBe('accepted');
    expect(res.body.data).toHaveProperty('contract');
  });
});
