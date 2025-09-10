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

  if (event.httpMethod !== 'POST') {
    console.log('Invalid method, returning 405');
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
    console.log('Webhook signature verified successfully');
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log('Event type:', stripeEvent.type);

  // Handle successful payment
  if (stripeEvent.type === 'payment_intent.succeeded') {
    const paymentIntent = stripeEvent.data.object;
    const metadata = paymentIntent.metadata;

    console.log('=== PROCESSING PAYMENT ===');
    console.log('Payment Intent ID:', paymentIntent.id);
    console.log('Metadata:', JSON.stringify(metadata, null, 2));

    // Validate metadata
    if (!metadata.userId || !metadata.username || !metadata.amountPaid) {
      console.error('Missing required metadata');
      return { statusCode: 400, body: 'Missing required metadata' };
    }

    try {
      // Use Firebase transaction with correct read/write order
      const result = await db.runTransaction(async (transaction) => {
        console.log('=== STARTING TRANSACTION ===');
        
        // ========================================
        // STEP 1: ALL READS FIRST
        // ========================================
        
        // Read user data
        const userRef = db.collection('users').doc(metadata.userId);
        const userDoc = await transaction.get(userRef);

        if (!userDoc.exists) {
          throw new Error('User not found: ' + metadata.userId);
        }

        const userData = userDoc.data();
        console.log('User data read:', metadata.username);

        // Read current king data
        const kingRef = db.collection('current').doc('king');
        const currentKingDoc = await transaction.get(kingRef);
        
        let previousKingData = null;
        let previousKingRef = null;
        let previousKingDocData = null;

        if (currentKingDoc.exists) {
          previousKingData = currentKingDoc.data();
          console.log('Current king data read:', previousKingData.username);
          
          // If there's a previous king and it's different, read their data too
          if (previousKingData.userId && previousKingData.userId !== metadata.userId) {
            previousKingRef = db.collection('users').doc(previousKingData.userId);
            const prevKingDoc = await transaction.get(previousKingRef);
            if (prevKingDoc.exists) {
              previousKingDocData = prevKingDoc.data();
              console.log('Previous king data read:', previousKingDocData.username || 'unknown');
            }
          }
        }

        console.log('All reads completed successfully');

        // ========================================
        // STEP 2: CALCULATE VALUES
        // ========================================
        
        const amountPaid = parseFloat(metadata.amountPaid);
        const newTotalInvestment = parseFloat(metadata.newTotalInvestment);
        const willBecomeKing = metadata.willBecomeKing === 'true';

        console.log('Previous investment:', userData.totalInvested || 0);
        console.log('Amount paid:', amountPaid);
        console.log('New total investment:', newTotalInvestment);
        console.log('Will become king:', willBecomeKing);

        // ========================================
        // STEP 3: ALL WRITES
        // ========================================

        // Update user's total investment
        transaction.update(userRef, {
          totalInvested: newTotalInvestment,
          lastPaymentAmount: amountPaid,
          lastPaymentDate: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('User investment updated');

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
          willBecomeKing: willBecomeKing
        });
        console.log('Payment history added');

        // If user becomes king, update king data and stats
        if (willBecomeKing) {
          console.log('=== UPDATING KING ===');

          // Update previous king's statistics if exists
          if (previousKingRef && previousKingDocData && previousKingData) {
            const reignDuration = Date.now() - (previousKingData.crownedAt?.toMillis() || Date.now());
            
            transaction.update(previousKingRef, {
              'stats.totalTimeAsKing': (previousKingDocData.stats?.totalTimeAsKing || 0) + reignDuration,
              'stats.longestReign': Math.max(
                previousKingDocData.stats?.longestReign || 0,
                reignDuration
              )
            });
            console.log('Previous king stats updated');
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
          console.log('New king set:', metadata.username, 'with amount:', newTotalInvestment);

          // Update new king's statistics
          const newKingStats = userData.stats || {};
          transaction.update(userRef, {
            'stats.timesAsKing': (newKingStats.timesAsKing || 0) + 1
          });
          console.log('New king stats updated');
        } else {
          console.log('User will not become king');
        }

        return { success: true, willBecomeKing };
      });

      console.log('=== TRANSACTION COMPLETED SUCCESSFULLY ===');
      console.log('Final result:', result);

    } catch (error) {
      console.error('=== TRANSACTION FAILED ===');
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