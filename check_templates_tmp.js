const { connectDB } = require('./src/config/db');
const { ProjectTemplate, User } = require('./src/models');
(async () => {
  await connectDB();
  const user = await User.findOne({ email: 'demo-funder@mboatrust.test' }).lean();
  console.log('user:', user ? user._id.toString() : null);
  const templates = await ProjectTemplate.find({}).sort('-createdAt').limit(5).lean();
  console.log('recent templates:', JSON.stringify(templates, null, 2));
  process.exit(0);
})();
