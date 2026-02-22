const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');

const router = express.Router();

router.get('/register', (req, res) => {
  res.render('register', { title: 'Register', error: null });
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.render('register', { title: 'Register', error: 'All fields are required.' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.render('register', { title: 'Register', error: 'Email already registered.' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(24).toString('hex');

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password: hashed,
      token,
    });

    req.session.user = {
      id: user._id,
      name: user.name,
      email: user.email,
      isAdmin: user.isAdmin,
      isActive: user.isActive,
    };

    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.render('register', { title: 'Register', error: 'Registration failed.' });
  }
});

router.get('/login', (req, res) => {
  res.render('login', { title: 'Login', error: null });
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.render('login', { title: 'Login', error: 'Invalid email or password.' });
    }
    if (!user.isActive) {
      return res.render('login', { title: 'Login', error: 'Account is suspended.' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.render('login', { title: 'Login', error: 'Invalid email or password.' });
    }

    req.session.user = {
      id: user._id,
      name: user.name,
      email: user.email,
      isAdmin: user.isAdmin,
      isActive: user.isActive,
    };

    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.render('login', { title: 'Login', error: 'Login failed.' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
