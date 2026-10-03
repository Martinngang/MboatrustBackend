const request = require('supertest');
const app = require('../src/app');
const { User, EmailLog } = require('../src/models');
const { sendEmail } = require('../src/services/mailerService');

describe('Test 17: Email System & Delivery Logs', () => {
  let admin;

  beforeAll(async () => {
    admin = await User.findOneAndUpdate(
      { email: 'test-email-admin@mboatrust.test' },
      {
        fullName: 'Test Email Admin',
        email: 'test-email-admin@mboatrust.test',
        firebaseUid: 'test-email-admin-uid',
        roles: [{ roleType: 'admin', permissions: ['settings', 'support'] }],
      },
      { upsert: true, new: true }
    );
  });

  it('1. sendEmail service - dispatches transactional email and writes to EmailLog', async () => {
    const success = await sendEmail(
      {
        to: 'recipient@mboatrust.test',
        subject: 'Milestone Released Notification',
        html: '<p>Your milestone payment has been released to escrow.</p>',
        text: 'Your milestone payment has been released to escrow.',
      },
      { type: 'milestone_released' }
    );

    expect(success).toBe(true);

    const logEntry = await EmailLog.findOne({ recipientEmail: 'recipient@mboatrust.test' });
    expect(logEntry).not.toBeNull();
    expect(logEntry.status).toBe('sent');
  });

  it('2. GET /api/v1/admin/email-logs - admin can audit outgoing email logs', async () => {
    const res = await request(app)
      .get('/api/v1/admin/email-logs')
      .set('x-dev-user-id', String(admin._id));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('3. GET /api/v1/admin/email-logs/summary - admin gets delivery summary statistics', async () => {
    const res = await request(app)
      .get('/api/v1/admin/email-logs/summary')
      .set('x-dev-user-id', String(admin._id));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('sent');
    expect(res.body.data.sent).toBeGreaterThan(0);
  });
});
