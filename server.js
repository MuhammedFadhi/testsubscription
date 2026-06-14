require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const NGENIUS_BASE_URL = process.env.NGENIUS_BASE_URL || 'https://api-gateway.sandbox.ksa.ngenius-payments.com';
const NGENIUS_API_KEY = process.env.NGENIUS_API_KEY;
const NGENIUS_OUTLET_REF = process.env.NGENIUS_OUTLET_REF;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Subscription plans (amounts are in minor currency units, e.g. 1999 = SAR 19.99)
const PLANS = {
  basic: { name: 'Basic Plan', amount: 1999, currency: 'SAR' },
  pro: { name: 'Pro Plan', amount: 4999, currency: 'SAR' },
  enterprise: { name: 'Enterprise Plan', amount: 9999, currency: 'SAR' },
};

// Logs full error detail to the terminal so issues are easy to diagnose
function logError(context, err) {
  console.error('\n===== PAYMENT GATEWAY ERROR =====');
  console.error('Context :', context);
  console.error('Time    :', new Date().toISOString());
  if (err.response) {
    console.error('Status  :', err.response.status, err.response.statusText);
    console.error('URL     :', err.config?.url);
    console.error('Response body:', JSON.stringify(err.response.data, null, 2));
  } else if (err.request) {
    console.error('No response received from gateway');
    console.error('Request :', err.config?.url);
    console.error('Message :', err.message);
  } else {
    console.error('Message :', err.message);
  }
  console.error('==================================\n');
}

// Step 1: Authenticate with N-Genius and get a bearer access token
async function getAccessToken() {
  if (!NGENIUS_API_KEY) {
    throw new Error('NGENIUS_API_KEY is not set. Add it to your .env file.');
  }

  const response = await axios.post(
    `${NGENIUS_BASE_URL}/identity/auth/access-token`,
    { scope: NGENIUS_OUTLET_REF || '' },
    {
      headers: {
        Authorization: `Basic ${NGENIUS_API_KEY}`,
        'Content-Type': 'application/vnd.ni-identity.v1+json',
      },
    }
  );

  return response.data.access_token;
}

// Step 2: Create an order and get the hosted payment page link
app.post('/api/checkout', async (req, res) => {
  const { planId } = req.body;
  const plan = PLANS[planId];

  if (!plan) {
    return res.status(400).json({ error: 'Invalid plan selected' });
  }

  if (!NGENIUS_API_KEY || !NGENIUS_OUTLET_REF) {
    const message = 'Payment gateway is not configured. Set NGENIUS_API_KEY and NGENIUS_OUTLET_REF in .env';
    console.error('\n===== CONFIG ERROR =====');
    console.error(message);
    console.error('=========================\n');
    return res.status(500).json({ error: message });
  }

  try {
    const token = await getAccessToken();

    const orderResponse = await axios.post(
      `${NGENIUS_BASE_URL}/transactions/outlets/${NGENIUS_OUTLET_REF}/orders`,
      {
        action: 'AUTH',
        amount: { currencyCode: plan.currency, value: plan.amount },
        merchantAttributes: {
          redirectUrl: `http://localhost:${PORT}/payment/callback`,
          skipConfirmationPage: true,
        },
        emailAddress: 'test@example.com',
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/vnd.ni-payment.v2+json',
        },
      }
    );

    const paymentUrl = orderResponse.data?._links?.payment?.href;

    if (!paymentUrl) {
      throw new Error('Order created but no payment link was returned by the gateway');
    }

    console.log(`\nOrder created for "${plan.name}" -> redirecting to hosted payment page`);
    res.json({ paymentUrl });
  } catch (err) {
    logError(`Checkout failed for plan "${planId}"`, err);
    res.status(err.response?.status || 500).json({
      error: 'Payment gateway error',
      details: err.response?.data || err.message,
    });
  }
});

// Step 3: Handle the redirect back from the hosted payment page
app.get('/payment/callback', async (req, res) => {
  console.log('\nPayment callback received with query params:', req.query);

  const { ref } = req.query;

  if (!ref) {
    console.error('No order reference returned in callback');
    return res.redirect('/cancel.html');
  }

  try {
    const token = await getAccessToken();

    const orderResponse = await axios.get(
      `${NGENIUS_BASE_URL}/transactions/outlets/${NGENIUS_OUTLET_REF}/orders/${ref}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/vnd.ni-payment.v2+json',
        },
      }
    );

    const state = orderResponse.data.state;
    console.log('Order', ref, 'final state:', state);

    if (state === 'CAPTURED' || state === 'PURCHASED' || state === 'AUTHORISED') {
      return res.redirect('/success.html');
    }

    return res.redirect('/cancel.html');
  } catch (err) {
    logError(`Order status check failed for ref "${ref}"`, err);
    return res.redirect('/cancel.html');
  }
});

app.listen(PORT, () => {
  console.log(`\nSubscription test server running at http://localhost:${PORT}`);
  if (!NGENIUS_API_KEY || !NGENIUS_OUTLET_REF) {
    console.warn('Warning: NGENIUS_API_KEY / NGENIUS_OUTLET_REF not set yet. Checkout will fail until configured in .env');
  }
});
