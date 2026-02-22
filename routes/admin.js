const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const User = require('../models/User');
const Service = require('../models/Service');
const Recharge = require('../models/Recharge');
const Transaction = require('../models/Transaction');

const router = express.Router();

const OTP_BASE_URL = 'https://api.grizzlysms.com/stubs/handler_api.php';
const OTP_API_KEY = process.env.OTP_API_KEY || '';

const uploadDir = path.join(__dirname, '..', 'public', 'img', 'services');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      cb(null, name);
    },
  }),
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('Invalid file type.'));
    cb(null, true);
  },
  limits: { fileSize: 1 * 1024 * 1024 },
});

async function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  const user = await User.findById(req.session.user.id);
  if (!user || !user.isActive || !user.isAdmin) {
    return res.redirect('/dashboard');
  }
  req.currentUser = user;
  res.locals.user = {
    id: user._id,
    name: user.name,
    email: user.email,
    isAdmin: user.isAdmin,
    isActive: user.isActive,
    balance: user.balance,
  };
  next();
}

function parseBalance(resp) {
  if (!resp || typeof resp !== 'string') return null;
  if (!resp.startsWith('ACCESS_BALANCE')) return null;
  const parts = resp.split(':');
  return parts[1] || null;
}

router.get('/', requireAdmin, async (req, res) => {
  const totalUsers = await User.countDocuments({ isAdmin: false });
  const transactionsCount = await Transaction.countDocuments();
  const pendingRecharges = await Recharge.countDocuments({ status: 'pending' });

  let providerBalance = 'N/A';
  try {
    const url = `${OTP_BASE_URL}?api_key=${OTP_API_KEY}&action=getBalance`;
    const providerResp = await axios.get(url);
    providerBalance = parseBalance(providerResp.data) || 'N/A';
  } catch (err) {
    providerBalance = 'N/A';
  }

  const recentUsers = await User.find({ isAdmin: false })
    .sort({ createdAt: -1 })
    .limit(5);

  res.render('admin/dashboard', {
    title: 'Admin Dashboard',
    totalUsers,
    transactionsCount,
    pendingRecharges,
    providerBalance,
    recentUsers,
  });
});

router.get('/services', requireAdmin, async (req, res) => {
  const services = await Service.find().sort({ serviceName: 1 });
  res.render('admin/services', { title: 'Services', services });
});

router.post('/services/add', requireAdmin, upload.single('iconFile'), async (req, res) => {
  try {
    const { serviceId, serviceName, price, server, icon, country, maxPrice, providerIds, exceptProviderIds } = req.body;
    if (!serviceId || !serviceName || !price || !server) return res.redirect('/admin/services');
    const parsedCountry = Number(country);
    const parsedMaxPrice = maxPrice !== undefined && maxPrice !== '' ? Number(maxPrice) : null;
    const iconPath = req.file ? `/img/services/${req.file.filename}` : '';
    await Service.create({
      serviceId,
      serviceName,
      price: Number(price),
      country: Number.isFinite(parsedCountry) ? parsedCountry : 22,
      maxPrice: Number.isFinite(parsedMaxPrice) ? parsedMaxPrice : null,
      providerIds: String(providerIds || '').trim(),
      exceptProviderIds: String(exceptProviderIds || '').trim(),
      server,
      icon: iconPath
    });
    res.redirect('/admin/services');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/services');
  }
});

router.post('/services/toggle/:id', requireAdmin, async (req, res) => {
  const service = await Service.findById(req.params.id);
  if (service) {
    service.isActive = !service.isActive;
    await service.save();
  }
  res.redirect('/admin/services');
});

router.post('/services/edit/:id', requireAdmin, upload.single('iconFile'), async (req, res) => {
  try {
    const { serviceId, serviceName, price, server, icon, country, maxPrice, providerIds, exceptProviderIds } = req.body;
    const service = await Service.findById(req.params.id);
    if (!service) return res.redirect('/admin/services');
    if (!serviceId || !serviceName || !price || !server) return res.redirect('/admin/services');

    const parsedCountry = Number(country);
    const parsedMaxPrice = maxPrice !== undefined && maxPrice !== '' ? Number(maxPrice) : null;

    service.serviceId = serviceId;
    service.serviceName = serviceName;
    service.price = Number(price);
    service.country = Number.isFinite(parsedCountry) ? parsedCountry : 22;
    service.maxPrice = Number.isFinite(parsedMaxPrice) ? parsedMaxPrice : null;
    service.providerIds = String(providerIds || '').trim();
    service.exceptProviderIds = String(exceptProviderIds || '').trim();
    service.server = server;
    if (req.file) {
      service.icon = `/img/services/${req.file.filename}`;
    }

    await service.save();
    res.redirect('/admin/services');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/services');
  }
});

router.post('/services/delete/:id', requireAdmin, async (req, res) => {
  await Service.deleteOne({ _id: req.params.id });
  res.redirect('/admin/services');
});

router.get('/recharges', requireAdmin, async (req, res) => {
  const recharges = await Recharge.find().populate('userId').sort({ createdAt: -1 });
  res.render('admin/recharges', { title: 'Recharges', recharges });
});

router.post('/recharges/approve/:id', requireAdmin, async (req, res) => {
  const recharge = await Recharge.findById(req.params.id);
  if (!recharge || recharge.status !== 'pending') return res.redirect('/admin/recharges');

  recharge.status = 'approved';
  await recharge.save();

  const user = await User.findById(recharge.userId);
  user.balance += recharge.amount;
  await user.save();

  await Transaction.create({
    userId: user._id,
    type: 'credit',
    amount: recharge.amount,
    description: 'Recharge approved',
    status: 'completed',
  });

  res.redirect('/admin/recharges');
});

router.post('/recharges/reject/:id', requireAdmin, async (req, res) => {
  const recharge = await Recharge.findById(req.params.id);
  if (recharge) {
    recharge.status = 'rejected';
    await recharge.save();
  }
  res.redirect('/admin/recharges');
});

router.get('/users', requireAdmin, async (req, res) => {
  const users = await User.find({ isAdmin: false }).sort({ createdAt: -1 });
  res.render('admin/users', { title: 'Users', users });
});

router.post('/users/balance/:id', requireAdmin, async (req, res) => {
  const { amount, action } = req.body;
  const user = await User.findById(req.params.id);
  if (!user || !amount) return res.redirect('/admin/users');

  const amt = Number(amount);
  if (action === 'deduct') {
    user.balance = Math.max(0, user.balance - amt);
    await Transaction.create({
      userId: user._id,
      type: 'debit',
      amount: amt,
      description: 'Admin balance adjustment',
      status: 'completed',
    });
  } else {
    user.balance += amt;
    await Transaction.create({
      userId: user._id,
      type: 'credit',
      amount: amt,
      description: 'Admin balance adjustment',
      status: 'completed',
    });
  }
  await user.save();
  res.redirect('/admin/users');
});

router.post('/users/toggle/:id', requireAdmin, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (user) {
    user.isActive = !user.isActive;
    await user.save();
  }
  res.redirect('/admin/users');
});

module.exports = router;
