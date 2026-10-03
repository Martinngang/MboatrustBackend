const mongoose = require('mongoose');
const { connectDB } = require('../src/config/db');
const mailerConfig = require('../src/config/mailer');
const mtnMomoProvider = require('../src/services/paymentProviders/mtnMomoProvider');
const { EmailLog } = require('../src/models');

// Fast offline mock for MTN Momo collection and disbursement
mtnMomoProvider.collect = jest.fn().mockImplementation(async (params) => ({
  provider: 'mtn_momo',
  providerReference: `mock-momo-${Date.now()}`,
  status: 'completed',
  amount: params.amount,
  currency: params.currency,
}));

mtnMomoProvider.disburse = jest.fn().mockImplementation(async (params) => ({
  provider: 'mtn_momo',
  providerReference: `mock-disb-${Date.now()}`,
  status: 'completed',
  amount: params.amount,
  currency: params.currency,
}));

// Fast offline mock for nodemailer transporter
mailerConfig.buildTransporter = jest.fn().mockReturnValue({
  sendMail: jest.fn().mockImplementation(async (options) => {
    try {
      await EmailLog.create({
        recipientEmail: options.to || 'test@mboatrust.test',
        type: 'test',
        subject: options.subject || 'Test Email',
        status: 'sent',
      });
    } catch (_) {}
    return { messageId: `mock-msg-${Date.now()}` };
  }),
});

const { bootstrapAiAdvisor } = require('../src/services/bootstrapAdvisorService');

beforeAll(async () => {
  await connectDB();
  await bootstrapAiAdvisor();
});

afterAll(async () => {
  mongoose.connection.removeAllListeners('disconnected');
  await mongoose.connection.close();
});
