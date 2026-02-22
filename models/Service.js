const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
  serviceId: { type: String, required: true },
  serviceName: { type: String, required: true },
  price: { type: Number, required: true },
  country: { type: Number, default: 22 },
  maxPrice: { type: Number, default: null },
  providerIds: { type: String, default: '' },
  exceptProviderIds: { type: String, default: '' },
  server: { type: String, required: true },
  icon: { type: String, default: '??' },
  isActive: { type: Boolean, default: true }
});

module.exports = mongoose.model('Service', serviceSchema);
