const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
  const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
  };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { amount, idToken } = JSON.parse(event.body);

    if (!amount || !idToken) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Amount and idToken are required' })
      };
    }

    // Verify Firebase token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const userId = decodedToken.uid;

    // Get user data
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'User not found' })
      };
    }

    const userData = userDoc.data();

    // Get current king data
    const kingDoc = await db.collection('current').doc('king').get();
    let currentKingData = { amount: 0, username: 'Nadie' };
    if (kingDoc.exists) {
      currentKingData = kingDoc.data();
    }

    // Calculate required amount to become king
    const userCurrentInvestment = userData.totalInvested || 0;
    const requiredTotal = currentKingData.amount + 0.01;
    const requiredToPay = Math.max(0, requiredTotal - userCurrentInvestment);

    if (amount < requiredToPay) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: `Insufficient amount. You need at least $${requiredToPay.toFixed(2)}` 
        })
      };
    }

    // Calculate new total investment
    const newTotalInvestment = userCurrentInvestment + amount;
    const willBecomeKing = newTotalInvestment > currentKingData.amount;

    // Convert amount to cents for Stripe
    const amountInCents = Math.round(amount * 100);

    // Create Payment Intent with metadata
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'usd',
      metadata: {
        userId: userId,
        username: userData.username,
        email: userData.email,
        amountPaid: amount.toString(),
        previousInvestment: userCurrentInvestment.toString(),
        newTotalInvestment: newTotalInvestment.toString(),
        willBecomeKing: willBecomeKing.toString(),
        currentKingAmount: currentKingData.amount.toString(),
        timestamp: Date.now().toString()
      },
      description: `Puja de ${userData.username} - $${amount.toFixed(2)}`
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        willBecomeKing: willBecomeKing,
        newTotalInvestment: newTotalInvestment,
        amountPaid: amount
      })
    };

  } catch (error) {
    console.error('Error creating payment intent:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        details: error.message 
      })
    };
  }
};