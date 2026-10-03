const request = require('supertest');
const app = require('../src/app');
const { User, Project, Bid, Escrow } = require('../src/models');

describe('Test 16: Milestone Approval & Release of Funds', () => {
  let funder;
  let contractor;
  let project;
  let milestone;

  beforeAll(async () => {
    funder = await User.findOneAndUpdate(
      { email: 'test-release-funder@mboatrust.test' },
      {
        fullName: 'Test Release Funder',
        email: 'test-release-funder@mboatrust.test',
        firebaseUid: 'test-release-funder-uid',
        roles: [{ roleType: 'funder' }],
      },
      { upsert: true, new: true }
    );

    contractor = await User.findOneAndUpdate(
      { email: 'test-release-contractor@mboatrust.test' },
      {
        fullName: 'Test Release Contractor',
        email: 'test-release-contractor@mboatrust.test',
        firebaseUid: 'test-release-contractor-uid',
        roles: [{ roleType: 'contractor' }],
      },
      { upsert: true, new: true }
    );

    project = await Project.create({
      projectType: 'tender',
      status: 'in_progress',
      ownerId: funder._id,
      title: 'Water Well Drilling Project',
      category: 'Water & Sanitation',
      totalAmount: 100000,
      currency: 'XAF',
      milestones: [
        {
          name: 'Phase 1 Drilling',
          amount: 100000,
          orderIndex: 0,
          status: 'under_review',
          evidence: [
            {
              type: 'photo',
              fileUrl: 'https://res.cloudinary.com/mboatrust/image/upload/sample.jpg',
              submittedBy: contractor._id,
            },
          ],
        },
      ],
    });

    milestone = project.milestones[0];

    // Contractor must have an accepted bid to receive escrow release
    await Bid.create({
      projectId: project._id,
      contractorId: contractor._id,
      price: 100000,
      timelineDays: 10,
      status: 'accepted',
    });

    // Escrow must hold the funds
    await Escrow.create({
      projectId: project._id,
      funderId: funder._id,
      type: 'fund',
      grossAmount: 100000,
      netAmount: 100000,
      currency: 'XAF',
      paymentProvider: 'mtn_momo',
      providerRole: 'collection',
      status: 'completed',
    });
  });

  it('1. POST /api/v1/projects/:id/milestones/:milestoneId/approval - approves work and releases funds', async () => {
    const res = await request(app)
      .post(`/api/v1/projects/${project._id}/milestones/${milestone._id}/approval`)
      .set('x-dev-user-id', String(funder._id))
      .set('idempotency-key', `approve-milestone-${Date.now()}`)
      .send({ status: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const releasedMilestone = res.body.data.project.milestones.find(
      (m) => String(m._id) === String(milestone._id)
    );
    expect(releasedMilestone.status).toBe('released');
    expect(res.body.data.releasedEscrow).toBeDefined();
    expect(res.body.data.releasedEscrow).toHaveProperty('type', 'release');
  });

  it('2. Database verification - confirms payout record was generated', async () => {
    const releaseEscrow = await Escrow.findOne({
      projectId: project._id,
      type: 'release',
    });

    expect(releaseEscrow).not.toBeNull();
    expect(releaseEscrow.status).toBe('completed');
  });
});
