const request = require('supertest');
const app = require('../src/app');
const { User } = require('../src/models');

describe('Test 18: Sending and Receiving Messages', () => {
  let userA;
  let userB;
  let conversationId;

  beforeAll(async () => {
    userA = await User.findOneAndUpdate(
      { email: 'test-msg-user-a@mboatrust.test' },
      {
        fullName: 'Test Funder A',
        email: 'test-msg-user-a@mboatrust.test',
        firebaseUid: 'test-msg-user-a-uid',
        roles: [{ roleType: 'funder' }],
      },
      { upsert: true, new: true }
    );

    userB = await User.findOneAndUpdate(
      { email: 'test-msg-user-b@mboatrust.test' },
      {
        fullName: 'Test Contractor B',
        email: 'test-msg-user-b@mboatrust.test',
        firebaseUid: 'test-msg-user-b-uid',
        roles: [{ roleType: 'contractor' }],
      },
      { upsert: true, new: true }
    );
  });

  it('1. POST /api/v1/messages/direct - User A sends direct message to User B', async () => {
    const payload = {
      recipientId: String(userB._id),
      body: 'Hello contractor! Are you available to inspect the borehole site?',
    };

    const res = await request(app)
      .post('/api/v1/messages/direct')
      .set('x-dev-user-id', String(userA._id))
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('conversation');
    expect(res.body.data).toHaveProperty('message');
    expect(res.body.data.message.body).toBe(payload.body);

    conversationId = res.body.data.conversation._id;
  });

  it('2. GET /api/v1/conversations/:id/messages - User B retrieves conversation thread', async () => {
    const res = await request(app)
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set('x-dev-user-id', String(userB._id));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].body).toContain('Hello contractor');
  });

  it('3. POST /api/v1/conversations/:id/messages - User B replies in the conversation', async () => {
    const payload = {
      body: 'Yes, I am available tomorrow morning at 9am!',
    };

    const res = await request(app)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('x-dev-user-id', String(userB._id))
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.body).toBe(payload.body);
  });

  it('4. GET /api/v1/conversations - User A lists their active conversations', async () => {
    const res = await request(app)
      .get('/api/v1/conversations')
      .set('x-dev-user-id', String(userA._id));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);

    const match = res.body.data.find((c) => String(c._id) === String(conversationId));
    expect(match).toBeDefined();
  });
});
