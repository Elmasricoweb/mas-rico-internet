const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
  try {
    const serviceAccount = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Firebase Admin initialized successfully');
  } catch (error) {
    console.error('Error initializing Firebase Admin:', error);
  }
}

const db = admin.firestore();

exports.handler = async (event, context) => {
  console.log('=== WEBHOOK STARTED ===');
  console.log('Method:', event.httpMethod);
  console.log('Headers:', JSON.stringify(event.headers, null, 2));

  if (event.httpMethod !== 'POST') {
    console.log('Invalid method, returning 405');
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  console.log('Stripe signature present:', !!sig);
  console.log('Webhook secret configured:', !!endpointSecret);

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
    console.log('Webhook signature verified successfully');
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log('Event type:', stripeEvent.type);
  console.log('Event ID:', stripeEvent.id);

  // Handle successful payment
  if (stripeEvent.type === 'payment_intent.succeeded') {
    const paymentIntent = stripeEvent.data.object;
    const metadata = paymentIntent.metadata;

    console.log('=== PROCESSING PAYMENT ===');
    console.log('Payment Intent ID:', paymentIntent.id);
    console.log('Amount:', paymentIntent.amount);
    console.log('Metadata:', JSON.stringify(metadata, null, 2));

    // Validate metadata
    if (!metadata.userId || !metadata.username || !metadata.amountPaid) {
      console.error('Missing required metadata');
      return { statusCode: 400, body: 'Missing required metadata' };
    }

    try {
      // Use Firebase transaction to ensure data consistency
      const result = await db.runTransaction(async (transaction) => {
        console.log('=== STARTING TRANSACTION ===');
        
        // Get current user data
        const userRef = db.collection('users').doc(metadata.userId);
        const userDoc = await transaction.get(userRef);

        if (!userDoc.exists) {
          throw new Error('User not found: ' + metadata.userId);
        }

        console.log('User found:', metadata.username);
        const userData = userDoc.data();
        const amountPaid = parseFloat(metadata.amountPaid);
        const newTotalInvestment = parseFloat(metadata.newTotalInvestment);

        console.log('Previous investment:', userData.totalInvested || 0);
        console.log('Amount paid:', amountPaid);
        console.log('New total investment:', newTotalInvestment);

        // Update user's total investment
        const updatedUserData = {
          totalInvested: newTotalInvestment,
          lastPaymentAmount: amountPaid,
          lastPaymentDate: admin.firestore.FieldValue.serverTimestamp()
        };

        transaction.update(userRef, updatedUserData);
        console.log('User data updated');

        // Add to payment history
        const historyRef = db.collection('paymentHistory').doc();
        transaction.set(historyRef, {
          userId: metadata.userId,
          username: metadata.username,
          amountPaid: amountPaid,
          previousTotal: parseFloat(metadata.previousInvestment || '0'),
          newTotal: newTotalInvestment,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          paymentIntentId: paymentIntent.id,
          willBecomeKing: metadata.willBecomeKing === 'true'
        });
        console.log('Payment history added');

        // If user will become king, update king data
        if (metadata.willBecomeKing === 'true') {
          console.log('=== UPDATING KING ===');
          const kingRef = db.collection('current').doc('king');
          
          // Get current king data for statistics update
          const currentKingDoc = await transaction.get(kingRef);
          let previousKingId = null;
          
          if (currentKingDoc.exists) {
            const currentKingData = currentKingDoc.data();
            previousKingId = currentKingData.userId;
            console.log('Previous king:', currentKingData.username);
            
            // If there was a previous king and it's different, update their statistics
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
                console.log('Previous king stats updated');
              }
            }
          } else {
            console.log('No previous king found');
          }

          // Set new king
          const newKingData = {
            userId: metadata.userId,
            username: metadata.username,
            amount: newTotalInvestment,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            crownedAt: admin.firestore.FieldValue.serverTimestamp(),
            paymentIntentId: paymentIntent.id
          };

          transaction.set(kingRef, newKingData);
          console.log('New king set:', metadata.username, 'with amount:', newTotalInvestment);

          // Update new king's statistics
          const newKingStats = userData.stats || {};
          transaction.update(userRef, {
            'stats.timesAsKing': (newKingStats.timesAsKing || 0) + 1
          });
          console.log('New king stats updated');
        } else {
          console.log('User will not become king (amount not enough)');
        }

        return { success: true };
      });

      console.log('=== TRANSACTION COMPLETED SUCCESSFULLY ===');
      console.log('Result:', result);

    } catch (error) {
      console.error('=== TRANSACTION FAILED ===');
      console.error('Error details:', error);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      
      return { 
        statusCode: 500, 
        body: JSON.stringify({ 
          error: 'Error processing payment', 
          details: error.message 
        }) 
      };
    }
  } else {
    console.log('Event type not handled:', stripeEvent.type);
  }

  console.log('=== WEBHOOK COMPLETED SUCCESSFULLY ===');
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};