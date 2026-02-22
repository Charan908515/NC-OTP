const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Service = require('../models/Service');
const ActiveNumber = require('../models/ActiveNumber');
const Transaction = require('../models/Transaction');
const Recharge = require('../models/Recharge');

const router = express.Router();

const OTP_BASE_URL = 'https://api.grizzlysms.com/stubs/handler_api.php';
const OTP_API_KEY = process.env.OTP_API_KEY || '';

async function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  const user = await User.findById(req.session.user.id);
  if (!user || !user.isActive) {
    req.session.destroy(() => res.redirect('/login'));
    return;
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

function parseAccessNumber(resp) {
  if (!resp || typeof resp !== 'string') return null;
  if (!resp.startsWith('ACCESS_NUMBER')) return null;
  const parts = resp.split(':');
  if (parts.length < 3) return null;
  return { orderId: parts[1], phoneNumber: parts[2] };
}

function parseStatus(resp) {
  if (!resp || typeof resp !== 'string') return { status: 'waiting' };
  if (resp.startsWith('STATUS_OK')) {
    const code = resp.split(':')[1] || '';
    return { status: 'received', code };
  }
  if (resp.startsWith('STATUS_WAIT_RESEND')) return { status: 'resend' };
  if (resp.startsWith('STATUS_WAIT_RETRY')) {
    const lastCode = resp.split(':')[1] || '';
    return { status: 'waiting', lastCode };
  }
  if (resp.startsWith('STATUS_CANCEL')) return { status: 'cancelled' };
  return { status: 'waiting' };
}

router.get('/dashboard', requireAuth, async (req, res) => {
  const userId = req.currentUser._id;
  const activeNumbers = await ActiveNumber.find({
    userId,
    status: { $in: ['waiting', 'received'] },
  })
    .sort({ createdAt: -1 })
    .limit(5);

  const transactions = await Transaction.find({ userId })
    .sort({ createdAt: -1 })
    .limit(5);

  const totalRechargeAgg = await Recharge.aggregate([
    { $match: { userId, status: 'approved' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const totalRecharge = totalRechargeAgg.length ? totalRechargeAgg[0].total : 0;
  const totalNumbers = await ActiveNumber.countDocuments({ userId });

  res.render('dashboard', {
    title: 'Dashboard',
    activeNumbers,
    transactions,
    totalRecharge,
    totalNumbers,
  });
});

router.get('/buy', requireAuth, async (req, res) => {
  const services = await Service.find({ isActive: true }).sort({ serviceName: 1 });
  res.render('buy', { title: 'Buy Number', services });
});

router.post('/api/buy', requireAuth, async (req, res) => {
  try {
    const { serviceId } = req.body;
    const service = await Service.findById(serviceId);
    if (!service || !service.isActive) {
      return res.status(400).json({ error: 'Service unavailable.' });
    }

    const user = await User.findById(req.currentUser._id);
    if (user.balance < service.price) {
      return res.status(400).json({ error: 'Insufficient balance.' });
    }

    const params = new URLSearchParams({
      api_key: OTP_API_KEY,
      action: 'getNumber',
      service: service.serviceId,
      country: String(Number.isFinite(service.country) ? service.country : 22)
    });
    if (service.maxPrice !== null && service.maxPrice !== undefined && service.maxPrice !== '') {
      params.set('maxPrice', String(service.maxPrice));
    }
    if (service.providerIds) params.set('providerIds', service.providerIds);
    if (service.exceptProviderIds) params.set('exceptProviderIds', service.exceptProviderIds);
    const url = `${OTP_BASE_URL}?${params.toString()}`;
    const providerResp = await axios.get(url);
    const parsed = parseAccessNumber(providerResp.data);
    if (!parsed) {
      return res.status(400).json({ error: 'Provider error. Try again.' });
    }

    user.balance -= service.price;
    await user.save();

    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
    const activeNumber = await ActiveNumber.create({
      userId: user._id,
      orderId: parsed.orderId,
      number: parsed.phoneNumber,
      service: service.serviceId,
      serviceName: service.serviceName,
      server: service.server,
      amount: service.price,
      expiresAt,
    });

    await Transaction.create({
      userId: user._id,
      type: 'debit',
      amount: service.price,
      description: `Buy ${service.serviceName}`,
      status: 'completed',
    });

    return res.json({
      success: true,
      activeNumber: {
        _id: activeNumber._id,
        number: activeNumber.number,
        serviceName: activeNumber.serviceName,
        amount: activeNumber.amount,
        status: activeNumber.status,
        expiresAt: activeNumber.expiresAt
      },
      balance: user.balance,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to buy number.' });
  }
});

router.get('/api/otp/:id', requireAuth, async (req, res) => {
  try {
    const active = await ActiveNumber.findOne({ _id: req.params.id, userId: req.currentUser._id });
    if (!active) return res.status(404).json({ error: 'Not found' });
    if (active.status === 'received' || active.status === 'cancelled') {
      return res.json({ status: active.status, sms: active.sms || '' });
    }

    const url = `${OTP_BASE_URL}?api_key=${OTP_API_KEY}&action=getStatus&id=${active.orderId}`;
    const providerResp = await axios.get(url);
    const parsed = parseStatus(providerResp.data);

    if (parsed.status === 'received') {
      active.status = 'received';
      active.sms = parsed.code || '';
      await active.save();
    } else if (parsed.status === 'cancelled') {
      active.status = 'cancelled';
      await active.save();
    }

    const canResend = parsed.status === 'resend';
    return res.json({ status: active.status, sms: active.sms || '', canResend });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'OTP check failed.' });
  }
});

router.post('/api/resend/:id', requireAuth, async (req, res) => {
  try {
    const active = await ActiveNumber.findOne({ _id: req.params.id, userId: req.currentUser._id });
    if (!active) return res.status(404).json({ error: 'Not found' });
    if (active.status !== 'waiting') {
      return res.status(400).json({ error: 'Cannot resend.' });
    }

    let statusToSend = 3;
    try {
      const statusUrl = `${OTP_BASE_URL}?api_key=${OTP_API_KEY}&action=getStatus&id=${active.orderId}`;
      const statusResp = await axios.get(statusUrl);
      const parsed = parseStatus(statusResp.data);
      if (parsed.status === 'resend') statusToSend = 6;
    } catch (err) {}

    const url = `${OTP_BASE_URL}?api_key=${OTP_API_KEY}&action=setStatus&id=${active.orderId}&status=${statusToSend}`;
    await axios.get(url);

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Resend failed.' });
  }
});

router.post('/api/cancel/:id', requireAuth, async (req, res) => {
  try {
    const active = await ActiveNumber.findOne({ _id: req.params.id, userId: req.currentUser._id });
    if (!active) return res.status(404).json({ error: 'Not found' });
    if (active.status !== 'waiting') {
      return res.status(400).json({ error: 'Cannot cancel.' });
    }

    const url = `${OTP_BASE_URL}?api_key=${OTP_API_KEY}&action=setStatus&id=${active.orderId}&status=8`;
    await axios.get(url);

    active.status = 'cancelled';
    await active.save();

    const user = await User.findById(req.currentUser._id);
    user.balance += active.amount;
    await user.save();

    await Transaction.create({
      userId: user._id,
      type: 'credit',
      amount: active.amount,
      description: `Refund ${active.serviceName}`,
      status: 'completed',
    });

    return res.json({ success: true, balance: user.balance });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Cancel failed.' });
  }
});

router.get('/active', requireAuth, async (req, res) => {
  const activeNumbers = await ActiveNumber.find({
    userId: req.currentUser._id,
    status: { $in: ['waiting', 'received'] },
  }).sort({ createdAt: -1 });

  res.render('active', { title: 'Active Numbers', activeNumbers });
});

router.get('/transactions', requireAuth, async (req, res) => {
  const transactions = await Transaction.find({ userId: req.currentUser._id })
    .sort({ createdAt: -1 })
    .limit(50);
  res.render('transactions', { title: 'Transactions', transactions });
});

router.get('/recharge', requireAuth, async (req, res) => {
  const recharges = await Recharge.find({ userId: req.currentUser._id })
    .sort({ createdAt: -1 })
    .limit(10);
  res.render('recharge', {
    title: 'Recharge',
    recharges,
    upiId: process.env.UPI_ID || 'merchant@upi',
    upiQrUrl: process.env.UPI_QR_URL || '',
    error: req.query.error || '',
    success: req.query.success || '',
  });
});

router.post('/recharge', requireAuth, async (req, res) => {
  try {
    const { amount, utrNumber } = req.body;
    const amt = Number(amount);
    const utr = String(utrNumber || '').trim();
    if (!amt || amt <= 0 || !utr) {
      return res.redirect('/recharge?error=' + encodeURIComponent('Enter valid amount and UTR.'));
    }

    const exists = await Recharge.findOne({ utrNumber: utr });
    if (exists) {
      return res.redirect('/recharge?error=' + encodeURIComponent('UTR already submitted.'));
    }

    await Recharge.create({
      userId: req.currentUser._id,
      amount: amt,
      utrNumber: utr,
    });

    res.redirect('/recharge?success=' + encodeURIComponent('UTR submitted for manual approval.'));
  } catch (err) {
    console.error(err);
    res.redirect('/recharge?error=' + encodeURIComponent('Failed to submit UTR.'));
  }
});

router.get('/profile', requireAuth, async (req, res) => {
  const user = await User.findById(req.currentUser._id);
  res.render('profile', { title: 'Profile', user });
});

router.get('/api/balance', requireAuth, async (req, res) => {
  const user = await User.findById(req.currentUser._id);
  return res.json({ balance: user.balance });
});

module.exports = router;
