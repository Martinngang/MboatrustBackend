const request = require('supertest');
const app = require('../src/app');
const { User, Project, Bid, Escrow } = require('../src/models');

describe('Test 15: Contractor Submitting Milestone Evidence', () => {
  let funder;
  let contractor;
  let project;
  let milestone;

  beforeAll(async () => {
    funder = await User.findOneAndUpdate(
      { email: 'test-evidence-funder@mboatrust.test' },
      {
        fullName: 'Test Evidence Funder',
        email: 'test-evidence-funder@mboatrust.test',
        firebaseUid: 'test-evidence-funder-uid',
        roles: [{ roleType: 'funder' }],
      },
      { upsert: true, new: true }
    );

    contractor = await User.findOneAndUpdate(
      { email: 'test-evidence-contractor@mboatrust.test' },
      {
        fullName: 'Test Evidence Contractor',
        email: 'test-evidence-contractor@mboatrust.test',
        firebaseUid: 'test-evidence-contractor-uid',
        roles: [{ roleType: 'contractor' }],
      },
      { upsert: true, new: true }
    );

    project = await Project.create({
      projectType: 'tender',
      status: 'in_progress',
      ownerId: funder._id,
      title: 'Solar Water Borehole',
      category: 'Water & Sanitation',
      totalAmount: 100000,
      currency: 'XAF',
      milestones: [{ name: 'Excavation & Drilling', amount: 100000, orderIndex: 0, status: 'pending' }],
    });

    milestone = project.milestones[0];

    // Contractor must have an accepted bid to be the recognized contractor party
    await Bid.create({
      projectId: project._id,
      contractorId: contractor._id,
      price: 100000,
      timelineDays: 15,
      status: 'accepted',
    });

    // Milestone must have escrow coverage to be workable
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

  it('1. POST /api/v1/projects/:id/milestones/:milestoneId/evidence - contractor submits work proof', async () => {
    const payload = {
      type: 'photo',
      fileUrl: 'https://res.cloudinary.com/mboatrust/image/upload/sample-evidence.jpg',
      notes: 'Borehole excavation completed and inspected on site',
    };

    const res = await request(app)
      .post(`/api/v1/projects/${project._id}/milestones/${milestone._id}/evidence`)
      .set('x-dev-user-id', String(contractor._id))
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const updatedMilestone = res.body.data.milestones.find((m) => String(m._id) === String(milestone._id));
    expect(updatedMilestone).toBeDefined();
    expect(updatedMilestone.status).toBe('under_review');
    expect(updatedMilestone.evidence.length).toBeGreaterThan(0);
    expect(updatedMilestone.evidence[0].fileUrl).toBe(payload.fileUrl);
  });
});
