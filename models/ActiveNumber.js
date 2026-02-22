const mongoose = require('mongoose');

const activeNumberSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderId: { type: String, required: true },
  number: { type: String, required: true },
  service: { type: String, required: true },
  serviceName: { type: String, required: true },
  server: { type: String, required: true },
  amount: { type: Number, required: true },
  sms: { type: String, default: '' },
  status: { type: String, enum: ['waiting', 'received', 'cancelled'], default: 'waiting' },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ActiveNumber', activeNumberSchema);
