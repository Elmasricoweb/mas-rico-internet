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
  console.log('Webhook received');

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log('Event type:', stripeEvent.type);

  // Handle successful payment
  if (stripeEvent.type === 'payment_intent.succeeded') {
    const paymentIntent = stripeEvent.data.object;
    const metadata = paymentIntent.metadata;

    console.log('Processing successful payment:', {
      userId: metadata.userId,
      username: metadata.username,
      amountPaid: metadata.amountPaid,
      willBecomeKing: metadata.willBecomeKing
    });

    try {
      // Use Firebase transaction to ensure data consistency
      await db.runTransaction(async (transaction) => {
        // Get current user data
        const userRef = db.collection('users').doc(metadata.userId);
        const userDoc = await transaction.get(userRef);

        if (!userDoc.exists) {
          throw new Error('User not found');
        }

        const userData = userDoc.data();
        const amountPaid = parseFloat(metadata.amountPaid);
        const newTotalInvestment = parseFloat(metadata.newTotalInvestment);

        // Update user's total investment
        const updatedUserData = {
          ...userData,
          totalInvested: newTotalInvestment,
          lastPaymentAmount: amountPaid,
          lastPaymentDate: admin.firestore.FieldValue.serverTimestamp()
        };

        transaction.update(userRef, updatedUserData);

        // Add to payment history
        const historyRef = db.collection('paymentHistory').doc();
        transaction.set(historyRef, {
          userId: metadata.userId,
          username: metadata.username,
          amountPaid: amountPaid,
          previousTotal: parseFloat(metadata.previousInvestment),
          newTotal: newTotalInvestment,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          paymentIntentId: paymentIntent.id,
          willBecomeKing: metadata.willBecomeKing === 'true'
        });

        // If user will become king, update king data
        if (metadata.willBecomeKing === 'true') {
          const kingRef = db.collection('current').doc('king');
          
          // Get current king data for statistics update
          const currentKingDoc = await transaction.get(kingRef);
          let previousKingId = null;
          
          if (currentKingDoc.exists) {
            const currentKingData = currentKingDoc.data();
            previousKingId = currentKingData.userId;
            
            // If there was a previous king, update their statistics
            if (previousKingId && previousKingId !== metadata.userId) {
              const prevKingRef = db.collection('users').doc(previousKingId);
              const prevKingDoc = await transaction.get(prevKingRef);
              
              if (prevKingDoc.exists) {
                const prevKingData = prevKingDoc.data();
                const reignDuration = Date.now() - (currentKingData.crownedAt?.toMillis() || Date.now());
                
                transaction.update(prevKingRef, {
                  'stats.totalTimeAsKing': (prevKingData.stats?.totalTimeAsKing || 0) + reignDuration,
                  'stats.longestReign': Math.max(
                    prevKingData.stats?.longestReign || 0,
                    reignDuration
                  )
                });
              }
            }
          }

          // Set new king
          transaction.set(kingRef, {
            userId: metadata.userId,
            username: metadata.username,
            amount: newTotalInvestment,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            crownedAt: admin.firestore.FieldValue.serverTimestamp(),
            paymentIntentId: paymentIntent.id
          });

          // Update new king's statistics
          const newKingStats = userData.stats || {};
          transaction.update(userRef, {
            'stats.timesAsKing': (newKingStats.timesAsKing || 0) + 1
          });

          console.log('New king crowned:', metadata.username, 'with $', newTotalInvestment);
        }
      });

      console.log('Transaction completed successfully');

    } catch (error) {
      console.error('Error processing payment:', error);
      return { statusCode: 500, body: 'Error processing payment' };
    }
  }

  return { statusCode: 200, body: 'Success' };
};